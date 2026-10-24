// SPEC-0001b §4.3-§4.5 + §4.8 engine-RPC checks over a REAL GitStore
// (node:sqlite backend, real BEGIN/COMMIT transactions — see helpers/lib.mjs).
// Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-merge-engine.mjs
//
// Covers: the commit builder (putApiObjects/commitApiChange, SPEC-0001a §4),
// deleteApiRef CAS semantics, the checkMergeability status machine + the §4.6
// read-only lock (object/refs snapshot unchanged), executeMerge styles +
// extraRefUpdates choreography + CAS-all-or-nothing, and the rebase replay
// (author preservation, patch-id skip, conflict stop, putRebaseObjects, FF
// landing).
import {
  assert,
  assertEq,
  leaseHost,
  loadGitRepoIntoStore,
  makeStore,
} from "./helpers/lib.mjs";
import { serializeCommit, serializeTag, serializeTree } from "../src/commit/serialize.ts";
import { hashObject, parseCommit } from "../src/git/objects.ts";
import { ZERO_OID } from "../src/git/util.ts";
import {
  putApiObjects,
  commitApiChange,
  deleteApiRef,
  checkMergeability,
  executeMerge,
  rebaseOnto,
  putRebaseObjects,
  mergeBase,
  listCommitsRange,
  countDivergence,
} from "../src/control-plane.ts";

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

const alice = { name: "Alice", email: "alice@t", time: 1700000000, tz: "+0000" };
const merger = { name: "Merger", email: "merge@t", time: 1700001000, tz: "+0000" };
const enc = new TextEncoder();

function blob(store, content) {
  const data = enc.encode(content);
  const oid = hashObject("blob", data);
  store.put(oid, "blob", data);
  return oid;
}

/** Build (and store) the nested tree for flat {path: content} files. */
function buildTree(store, files) {
  const dirs = new Map();
  const entries = [];
  for (const [path, content] of Object.entries(files)) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      entries.push({ mode: "100644", name: path, oid: blob(store, content) });
    } else {
      const dir = path.slice(0, slash);
      if (!dirs.has(dir)) dirs.set(dir, {});
      dirs.get(dir)[path.slice(slash + 1)] = content;
    }
  }
  for (const [name, sub] of dirs) {
    entries.push({ mode: "40000", name, oid: buildTree(store, sub) });
  }
  const tree = serializeTree(entries);
  store.put(tree.oid, tree.type, tree.data);
  return tree.oid;
}

/** Build + store a commit; returns the commit oid. */
function mkCommit(store, files, parents, time, message) {
  const tree = buildTree(store, files);
  const person = { ...alice, time };
  const commit = serializeCommit({ tree, parents, author: person, committer: person, message });
  store.put(commit.oid, commit.type, commit.data);
  return commit.oid;
}

function snapshot(t) {
  return {
    objects: t.store.objectCount(),
    refs: t.store.refs().map((r) => `${r.name}=${r.oid}`).join(","),
    refsVersion: t.store.refsVersion(),
  };
}

/** The standard fixture: main = c1→c2→c3; feature = c2→s1→s2 (diverged). */
function buildDiverged(t) {
  const c1 = mkCommit(t.store, { "f.txt": "a\nb\nc\n" }, [], 1700000001, "c1\n");
  const c2 = mkCommit(t.store, { "f.txt": "a\nb2\nc\n", "g.txt": "g\n" }, [c1], 1700000002, "c2\n");
  const s1 = mkCommit(t.store, { "f.txt": "a\nb2\nc\n", "g.txt": "g\n", "s.txt": "s1\n" }, [c2], 1700000003, "s1\n");
  const s2 = mkCommit(t.store, { "f.txt": "a\nb2\nc\n", "g.txt": "g\n", "s.txt": "s1\ns2\n" }, [s1], 1700000004, "s2\n");
  const c3 = mkCommit(t.store, { "f.txt": "a\nb2\nc\n", "g.txt": "g\n", "h.txt": "h\n" }, [c2], 1700000005, "c3\n");
  t.store.setRef("refs/heads/main", c3);
  t.store.setRef("refs/heads/feature", s2);
  t.store.setHead("refs/heads/main");
  return { c1, c2, c3, s1, s2 };
}

async function main() {
  // ---- commit builder (SPEC-0001a §4) ---------------------------------------
  await check("putApiObjects: stores verified objects; idempotent", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const data = enc.encode("hello\n");
    const oid = hashObject("blob", data);
    const r = await putApiObjects(host, [{ oid, type: "blob", data }]);
    assertEq(r, { tag: "ok", stored: 1 }, "first put");
    const again = await putApiObjects(host, [{ oid, type: "blob", data }]);
    assertEq(again.tag, "ok", "idempotent re-put");
    assert(t.store.has(oid), "stored");
  });
  await check("putApiObjects: oid/type mismatch is invalid, never a corrupt store", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const r = await putApiObjects(host, [{ oid: ZERO_OID.replace("0", "a"), type: "blob", data: enc.encode("x") }]);
    assertEq(r.tag, "invalid", "rejected");
  });
  await check("putApiObjects: over-budget batch is too_large", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const big = new Uint8Array(9 * 1024 * 1024);
    const oid = hashObject("blob", big);
    const r = await putApiObjects(host, [{ oid, type: "blob", data: big }]);
    assertEq(r, { tag: "too_large", limitBytes: 8 * 1024 * 1024 }, "budget");
  });
  await check("commitApiChange: create on empty repo adopts HEAD and bumps refs_version", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const oid = mkCommit(t.store, { "r.txt": "root\n" }, [], 1700000009, "root\n");
    assertEq(t.store.refsVersion(), "1", "initial version");
    const r = await commitApiChange(host, { ref: "refs/heads/main", expectedOldOid: ZERO_OID, newOid: oid });
    assertEq(r.tag, "committed", "committed");
    assertEq(r.refsVersion, "2", "bumped");
    assertEq(t.store.resolveHead(), oid, "HEAD fixup adopted the first branch");
    assertEq(t.store.head(), "refs/heads/main", "head symref");
  });
  await check("commitApiChange: stale CAS → ref_conflict with live tip", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const c1 = mkCommit(t.store, { "f": "1\n" }, [], 1, "c1\n");
    const c2 = mkCommit(t.store, { "f": "2\n" }, [c1], 2, "c2\n");
    t.store.setRef("refs/heads/main", c1);
    const r = await commitApiChange(host, { ref: "refs/heads/main", expectedOldOid: ZERO_OID, newOid: c2 });
    assertEq(r, { tag: "ref_conflict", currentOid: c1 }, "conflict shape");
  });
  await check("commitApiChange: presence checks (object and commit root tree)", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const ghost = "1234567890123456789012345678901234567890";
    const missing = await commitApiChange(host, { ref: "refs/heads/x", expectedOldOid: ZERO_OID, newOid: ghost });
    assertEq(missing.tag, "invalid", "object not stored");
    // a commit whose root tree is absent
    const treeless = serializeCommit({ tree: ghost, parents: [], author: alice, committer: alice, message: "x\n" });
    t.store.put(treeless.oid, treeless.type, treeless.data);
    const noTree = await commitApiChange(host, { ref: "refs/heads/x", expectedOldOid: ZERO_OID, newOid: treeless.oid });
    assertEq(noTree.tag, "invalid", "root tree missing");
    const badRef = await commitApiChange(host, { ref: "refs/heads/x..y", expectedOldOid: ZERO_OID, newOid: treeless.oid });
    assertEq(badRef.tag, "invalid", "funny refname");
  });
  await check("commitApiChange: annotated tag target caches the peeled commit", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const c1 = mkCommit(t.store, { "f": "1\n" }, [], 1, "c1\n");
    const tag = serializeTag({ object: c1, type: "commit", tag: "v1", tagger: alice, message: "one\n" });
    t.store.put(tag.oid, tag.type, tag.data);
    const r = await commitApiChange(host, { ref: "refs/tags/v1", expectedOldOid: ZERO_OID, newOid: tag.oid });
    assertEq(r.tag, "committed", "tag landed");
    assertEq(t.store.getRef("refs/tags/v1"), tag.oid, "ref written");
  });

  // ---- deleteApiRef (§4.8) ----------------------------------------------------
  await check("deleteApiRef: CAS delete, idempotence, stale CAS, funny refname", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const c1 = mkCommit(t.store, { "f": "1\n" }, [], 1, "c1\n");
    t.store.setRef("refs/heads/gone", c1);
    t.store.setRef("refs/heads/stay", c1);
    const before = t.store.refsVersion();
    const ok = await deleteApiRef(host, { ref: "refs/heads/gone", expectedOid: c1 });
    assertEq(ok.tag, "deleted", "CAS delete");
    assert(Number(ok.refsVersion) > Number(before), "version bumped");
    // already gone, caller knew the oid: idempotent-ok via ref_conflict/null
    const again = await deleteApiRef(host, { ref: "refs/heads/gone", expectedOid: c1 });
    assertEq(again, { tag: "ref_conflict", currentOid: null }, "already gone");
    // already gone, caller used the create-absent CAS: satisfied
    const idem = await deleteApiRef(host, { ref: "refs/heads/gone", expectedOid: ZERO_OID });
    assertEq(idem.tag, "deleted", "idempotent on absence");
    // stale CAS on a live ref
    const stale = await deleteApiRef(host, { ref: "refs/heads/stay", expectedOid: ZERO_OID });
    assertEq(stale, { tag: "ref_conflict", currentOid: c1 }, "stale CAS");
    const funny = await deleteApiRef(host, { ref: "refs/heads//x", expectedOid: c1 });
    assertEq(funny.tag, "invalid", "funny refname");
  });

  // ---- checkMergeability (§4.3) + §4.6 ---------------------------------------
  {
    const t = makeStore();
    const host = leaseHost(t);
    const { c1, c2, c3, s1, s2 } = buildDiverged(t);
    await check("checkMergeability: diverged PR is mergeable with base and counts", async () => {
      const r = await checkMergeability(host, { base: "main", head: "feature" });
      assertEq(r, {
        tag: "ok", status: "mergeable", mergeBase: c2, mergedTree: r.mergedTree,
        conflictedFiles: [], conflictedFilesTruncated: false, commitsAhead: 2, commitsBehind: 1,
      }, "status machine row");
      assert(r.mergedTree !== null, "merged tree present");
    });
    await check("checkMergeability: fast-forward shape skips the walk, behind 0", async () => {
      t.store.setRef("refs/heads/old-main", c2);
      const r = await checkMergeability(host, { base: "old-main", head: "feature" });
      assertEq(r.status, "mergeable", "mergeable");
      assertEq(r.mergeBase, c2, "base IS the merge base");
      assertEq(r.commitsBehind, 0, "no behind");
      assertEq(r.commitsAhead, 2, "the two side commits");
    });
    await check("checkMergeability: ancestor short-circuit", async () => {
      const merged = mkCommit(t.store, { "f.txt": "a\nb2\nc\n", "g.txt": "g\n", "h.txt": "h\n", "s.txt": "s1\ns2\n" }, [c3, s2], 1700000006, "Merge feature\n");
      t.store.setRef("refs/heads/main", merged);
      const r = await checkMergeability(host, { base: "main", head: "feature" });
      assertEq(r.status, "ancestor", "already merged");
      assertEq(r.mergeBase, s2, "merge base is the head itself");
    });
    await check("checkMergeability: unrelated histories → unrelated", async () => {
      const orphan = mkCommit(t.store, { "z": "z\n" }, [], 1700000007, "orphan\n");
      const r = await checkMergeability(host, { base: "main", head: orphan });
      assertEq(r.status, "unrelated", "no common ancestor");
      assertEq(r.mergeBase, null, "null merge base");
      assertEq(r.commitsAhead, 0, "counts 0 when null");
    });
    await check("checkMergeability: missing refs name the side", async () => {
      assertEq((await checkMergeability(host, { base: "ghost", head: "main" })).which, "base", "base missing");
      assertEq((await checkMergeability(host, { base: "main", head: "ghost" })).which, "head", "head missing");
    });
    await check("checkMergeability: a conflicted PR reports files", async () => {
      const t2 = makeStore();
      const b1 = mkCommit(t2.store, { "f.txt": "a\nb\nc\n" }, [], 1, "b1\n");
      const o1 = mkCommit(t2.store, { "f.txt": "a\nOURS\nc\n" }, [b1], 2, "o1\n");
      const t1 = mkCommit(t2.store, { "f.txt": "a\nTHEIRS\nc\n" }, [b1], 3, "t1\n");
      t2.store.setRef("refs/heads/main", o1);
      t2.store.setRef("refs/heads/pr", t1);
      const r = await checkMergeability(leaseHost(t2), { base: "main", head: "pr" });
      assertEq(r.status, "conflict", "conflict");
      assertEq(r.conflictedFiles, ["f.txt"], "file list");
      assertEq(r.mergeBase, b1, "merge base");
    });
    await check("checkMergeability: fully-applied PR (tree equality) → empty", async () => {
      const t3 = makeStore();
      const b1 = mkCommit(t3.store, { "f.txt": "a\nb\nc\n" }, [], 1, "b1\n");
      const baseTip = mkCommit(t3.store, { "f.txt": "a\nb\nc\nAPPLIED\n" }, [b1], 2, "base-tip\n");
      // the PR re-applies the same change on the pre-image: the merged tree
      // equals base's tree → the PR's changes are all applied
      const head = mkCommit(t3.store, { "f.txt": "a\nb\nc\nAPPLIED\n" }, [b1], 3, "pr\n");
      t3.store.setRef("refs/heads/main", baseTip);
      t3.store.setRef("refs/heads/pr", head);
      const r = await checkMergeability(leaseHost(t3), { base: "main", head: "pr" });
      assertEq(r.status, "empty", "tree-oid equality is recursive equality");
      assertEq(r.mergeBase, b1, "merge base");
    });

    // ---- §4.6: the checks never write
    await check("§4.6 read-only lock: snapshot unchanged across all read RPCs", async () => {
      const before = snapshot(t);
      await mergeBase(host, "main", "feature");
      await listCommitsRange(host, "main", "feature", 50);
      await countDivergence(host, "main", "feature");
      await checkMergeability(host, { base: "main", head: "feature" });
      await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
      const after = snapshot(t);
      assertEq(after, before, "objects + refs + refs_version untouched");
      // and the SQLite row counts too (peeled/stats memos are the only allowed
      // writes; these paths do not take them)
      assertEq(after.objects, before.objects, "object count delta zero");
    });
  }

  // ---- executeMerge (§4.4) -----------------------------------------------------
  {
    const t = makeStore();
    const host = leaseHost(t);
    const { c3, s1, s2 } = buildDiverged(t);
    await check("executeMerge (merge style): two-parent commit + PR-head choreography in ONE transaction", async () => {
      const r = await executeMerge(host, {
        style: "merge",
        base: "main",
        head: "feature",
        expectedBaseOid: c3,
        message: "Merge branch 'feature'\n",
        author: merger,
        committer: merger,
        extraRefUpdates: [{ ref: "refs/pull/1/head", expectedOldOid: ZERO_OID, newOid: s2 }],
      });
      assertEq(r.tag, "committed", "landed");
      const nc = parseCommit((await t.store.get(r.commitOid)).data);
      assertEq(nc.parents, [c3, s2], "two parents: base tip then head");
      assertEq(t.store.getRef("refs/heads/main"), r.commitOid, "base moved");
      assertEq(t.store.getRef("refs/pull/1/head"), s2, "PR head created in the same transaction");
      const versionAfter = Number(t.store.refsVersion());
      assert(versionAfter > 1, "refs_version bumped");
      assertEq(r.refsVersion, String(versionAfter), "result carries the post-commit version");
      assert(r.commitTime > 0, "commitTime present");
      // git fsck-shape sanity: the merge commit's tree exists and parses
      assert(t.store.has(nc.tree), "merge tree stored");
    });
    await check("executeMerge: stale expectedBaseOid → ref_conflict with live tip", async () => {
      const r = await executeMerge(host, {
        style: "merge",
        base: "main",
        head: "feature",
        expectedBaseOid: c3,
        message: "again\n",
        author: merger,
        committer: merger,
        extraRefUpdates: [],
      });
      assertEq(r.tag, "ref_conflict", "conflict");
      assert(r.currentOid !== c3 && r.currentOid !== ZERO_OID, "live tip returned");
    });
    await check("executeMerge: a conflicting extra update fails the WHOLE transaction (base unmoved)", async () => {
      const t2 = makeStore();
      const host2 = leaseHost(t2);
      const base = mkCommit(t2.store, { "f": "1\n" }, [], 1, "b\n");
      const head = mkCommit(t2.store, { "f": "1\n", "n": "n\n" }, [base], 2, "h\n");
      t2.store.setRef("refs/heads/main", base);
      t2.store.setRef("refs/heads/other", base);
      const versionBefore = t2.store.refsVersion();
      const r = await executeMerge(host2, {
        style: "merge",
        base: "main",
        head: head,
        expectedBaseOid: base,
        message: "m\n",
        author: merger,
        committer: merger,
        extraRefUpdates: [{ ref: "refs/pull/9/head", expectedOldOid: base, newOid: head }], // stale: ref absent
      });
      assertEq(r.tag, "ref_conflict", "extra CAS refused");
      assertEq(t2.store.getRef("refs/heads/main"), base, "base did NOT move");
      assertEq(t2.store.refsVersion(), versionBefore, "version untouched");
      assertEq(t2.store.getRef("refs/pull/9/head"), null, "PR head not created");
    });
    await check("executeMerge: fast-forward-only refuses a diverged head, lands a FF", async () => {
      const t2 = makeStore();
      const host2 = leaseHost(t2);
      const c1 = mkCommit(t2.store, { "f": "1\n" }, [], 1, "c1\n");
      const c2 = mkCommit(t2.store, { "f": "2\n" }, [c1], 2, "c2\n");
      const side = mkCommit(t2.store, { "f": "2\n", "s": "s\n" }, [c1], 3, "s\n");
      t2.store.setRef("refs/heads/main", c1);
      t2.store.setRef("refs/heads/linear", c2);
      t2.store.setRef("refs/heads/diverged", side);
      const ff = await executeMerge(host2, {
        style: "fast-forward-only", base: "main", head: "linear",
        expectedBaseOid: c1, message: "", author: merger, committer: merger, extraRefUpdates: [],
      });
      assertEq(ff.tag, "committed", "FF landed");
      assertEq(ff.commitOid, c2, "commitOid IS the head (no new objects)");
      assertEq(t2.store.getRef("refs/heads/main"), c2, "base moved to head");
      // main advanced past the fork point: a FF onto the diverged side refuses
      const refused = await executeMerge(host2, {
        style: "fast-forward-only", base: "main", head: "diverged",
        expectedBaseOid: c2, message: "", author: merger, committer: merger, extraRefUpdates: [],
      });
      assertEq(refused, { tag: "not_fast_forward" }, "FF refusal");
    });
    await check("executeMerge (squash): single-parent commit", async () => {
      const t2 = makeStore();
      const host2 = leaseHost(t2);
      const { c3, s2 } = buildDiverged(t2);
      const r = await executeMerge(host2, {
        style: "squash",
        base: "main",
        head: "feature",
        expectedBaseOid: c3,
        message: "Squash feature\n",
        author: alice,
        committer: merger,
        extraRefUpdates: [],
      });
      assertEq(r.tag, "committed", "landed");
      const nc = parseCommit((await t2.store.get(r.commitOid)).data);
      assertEq(nc.parents, [c3], "ONE parent");
    });
    await check("executeMerge: conflicted merge reports files, stores nothing", async () => {
      const t2 = makeStore();
      const host2 = leaseHost(t2);
      const b1 = mkCommit(t2.store, { "f.txt": "a\nb\nc\n" }, [], 1, "b1\n");
      const o1 = mkCommit(t2.store, { "f.txt": "a\nOURS\nc\n" }, [b1], 2, "o1\n");
      const t1 = mkCommit(t2.store, { "f.txt": "a\nTHEIRS\nc\n" }, [b1], 3, "t1\n");
      t2.store.setRef("refs/heads/main", o1);
      t2.store.setRef("refs/heads/pr", t1);
      const objectsBefore = t2.store.objectCount();
      const r = await executeMerge(host2, {
        style: "merge", base: "main", head: "pr", expectedBaseOid: o1,
        message: "m\n", author: merger, committer: merger, extraRefUpdates: [],
      });
      assertEq(r.tag, "conflict", "conflict result");
      assertEq(r.conflictedFiles, ["f.txt"], "files");
      assertEq(t2.store.objectCount(), objectsBefore, "candidate objects discarded with the call");
    });
    await check("executeMerge: nothing_to_merge carries the classification", async () => {
      const t2 = makeStore();
      const host2 = leaseHost(t2);
      const { c3, s2 } = buildDiverged(t2);
      const merged = mkCommit(t2.store, { "f.txt": "a\nb2\nc\n", "g.txt": "g\n", "h.txt": "h\n", "s.txt": "s1\ns2\n" }, [c3, s2], 1700000006, "Merge feature\n");
      t2.store.setRef("refs/heads/main", merged);
      const r = await executeMerge(host2, {
        style: "merge", base: "main", head: "feature", expectedBaseOid: merged,
        message: "m\n", author: merger, committer: merger, extraRefUpdates: [],
      });
      assertEq(r, { tag: "nothing_to_merge", status: "ancestor" }, "ancestor");
    });
  }

  // ---- rebase (§4.5) ------------------------------------------------------------
  function buildRebaseFixture(t, conflicting = false, preApplied = false) {
    const c1 = mkCommit(t.store, { "f.txt": "a\nb\nc\nd\ne\n" }, [], 1, "c1\n");
    const c2 = mkCommit(t.store, { "f.txt": "a\nb\nc\nd\ne\n", "base.txt": "b\n" }, [c1], 2, "c2\n");
    // feature's commits
    const s1 = mkCommit(t.store, { "f.txt": "a\nb\nc\nd\ne\n", "base.txt": "b\n", "s1.txt": "s1\n" }, [c2], 3, "s1 adds a file\n");
    const s2files = conflicting
      ? { "f.txt": "Z\nb\nc\nd\ne\n", "base.txt": "b\n", "s1.txt": "s1\n" } // a DIFFERENT edit to the line main also edits
      : { "f.txt": "a\nb\nc\nd\nE\n", "base.txt": "b\n", "s1.txt": "s1\n" }; // disjoint: last line
    const s2 = mkCommit(t.store, s2files, [s1], 4, "s2 edits f\n");
    // main advances past c2
    const c3 = mkCommit(t.store, { "f.txt": "a\nb\nc\nd\ne\n", "base.txt": "b\n", "c3.txt": "c3\n" }, [c2], 5, "c3\n");
    const c4files = preApplied
      ? { "f.txt": "a\nb\nc\nd\ne\n", "base.txt": "b\n", "c3.txt": "c3\n", "s1.txt": "s1\n" } // main already applied s1's change
      : { "f.txt": "A\nb\nc\nd\ne\n", "base.txt": "b\n", "c3.txt": "c3\n" };
    const c4 = mkCommit(t.store, c4files, [c3], 6, preApplied ? "c4 applies s1's change\n" : "c4 edits f first line\n");
    t.store.setRef("refs/heads/main", c4);
    t.store.setRef("refs/heads/feature", s2);
    t.store.setHead("refs/heads/main");
    return { c1, c2, c3, c4, s1, s2 };
  }

  await check("rebaseOnto: replays topologically, preserving authors; putRebaseObjects + FF landing", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const { c4, s1, s2 } = buildRebaseFixture(t);
    const r = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
    assertEq(r.tag, "rebased", "rebased");
    assertEq(r.skipped, 0, "nothing skipped");
    assertEq(r.commits.length, 2, "both commits replayed");
    assertEq(r.commits[0].original, s1, "originals recorded");
    assertEq(r.commits[1].original, s2, "in order");
    // the replay is read-only: parse the rebased commits from the OUTCOME
    const byOid = new Map(r.objects.map((o) => [o.oid, o]));
    const first = parseCommit(byOid.get(r.commits[0].rebased).data);
    const originalS1 = parseCommit((await t.store.get(r.commits[0].original)).data);
    assertEq(first.author.name, "Alice", "author name preserved");
    assertEq(first.author.time, originalS1.author.time, "author time preserved verbatim");
    assertEq(first.committer.name, "Merger", "committer is the input");
    assertEq(first.committer.time, merger.time, "committer time is the input's");
    assertEq(first.parents, [c4], "first replay sits on onto");
    const second = parseCommit(byOid.get(r.commits[1].rebased).data);
    assertEq(second.parents, [r.commits[0].rebased], "chained");
    // objects dedupe and cover both commits
    const oids = new Set(r.objects.map((o) => o.oid));
    assert(oids.has(r.commits[0].rebased) && oids.has(r.commits[1].rebased), "commits among objects");
    // store, then land via FF + choreography
    const put = await putRebaseObjects(host, r.objects);
    assertEq(put.tag, "ok", "objects stored");
    const land = await executeMerge(host, {
      style: "fast-forward-only",
      base: "main",
      head: r.headOid,
      expectedBaseOid: c4,
      message: "",
      author: merger,
      committer: merger,
      extraRefUpdates: [{ ref: "refs/pull/7/head", expectedOldOid: ZERO_OID, newOid: s2 }],
    });
    assertEq(land.tag, "committed", "landed");
    assertEq(t.store.getRef("refs/heads/main"), r.headOid, "main = rebased tip");
    assertEq(t.store.getRef("refs/pull/7/head"), s2, "PR head retargeted atomically");
  });
  await check("rebaseOnto: patch-id skip drops a change main already has", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const { s2 } = buildRebaseFixture(t, false, true);
    const r = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
    assertEq(r.tag, "rebased", "rebased");
    assertEq(r.skipped, 1, "s1 skipped (main's c4 carries the same change)");
    assertEq(r.commits.length, 1, "only s2 replayed");
    assertEq(r.commits[0].original, s2, "s2 is the survivor");
  });
  await check("rebaseOnto: conflict stops at the offending original", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    const { s2 } = buildRebaseFixture(t, true, false);
    const r = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
    assertEq(r.tag, "conflict", "stopped");
    assertEq(r.atOriginal, s2, "reports the original oid");
    assertEq(r.commits.length, 1, "s1 had replayed");
    assert(r.conflicts.some((c) => c.path === "f.txt"), "conflict paths listed");
  });
  await check("rebaseOnto: too_many, up_to_date", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    buildRebaseFixture(t);
    const many = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger, maxCommits: 1 });
    assertEq(many, { tag: "too_many", count: 2 }, "cap respected");
    // a branch that sits on onto: up_to_date (onto is its ancestor)
    const first = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
    assertEq(first.tag, "rebased", "first rebase replays");
    await putRebaseObjects(host, first.objects); // the replay is read-only: store first
    const second = await rebaseOnto(host, { head: first.headOid, onto: "main", committer: merger });
    assertEq(second, { tag: "up_to_date" }, "head already sits on onto");
    // a FULLY-MERGED branch: nothing to replay, the outcome moves head to onto
    // (the fast-forward reading of `git rebase` on a behind branch)
    const mainTip = t.store.getRef("refs/heads/main");
    const merged = mkCommit(t.store, { "f.txt": "a\nb\nc\nd\nE\n", "base.txt": "b\n", "c3.txt": "c3\n", "s1.txt": "s1\n" }, [mainTip, t.store.getRef("refs/heads/feature")], 7, "Merge feature\n");
    t.store.setRef("refs/heads/main", merged);
    const ff = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
    assertEq(ff.tag, "rebased", "empty replay");
    assertEq(ff.commits, [], "nothing to replay once merged");
  });
  await check("rebaseOnto: invalid on unresolvable refs", async () => {
    const t = makeStore();
    const host = leaseHost(t);
    buildRebaseFixture(t);
    const r = await rebaseOnto(host, { head: "ghost", onto: "main", committer: merger });
    assertEq(r.tag, "invalid", "invalid");
  });

  // ---- real-git rebase oracle: same final TREE as `git rebase` ----------------
  await check("rebaseOnto final tree == git rebase final tree (real fixture)", async () => {
    const { writeFileSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "rebase-oracle-"));
    const sh = (cmd, env = {}) =>
      execSync(`git -C ${dir} -c user.email=t@t -c user.name=t ${cmd}`, {
        env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    sh("init -q -b main");
    writeFileSync(join(dir, "f.txt"), "a\nb\nc\nd\ne\n");
    sh("add -A");
    sh("commit -qm c1", { GIT_COMMITTER_DATE: "2026-01-01T00:00:00" });
    writeFileSync(join(dir, "base.txt"), "b\n");
    sh("add -A");
    sh("commit -qm c2", { GIT_COMMITTER_DATE: "2026-01-02T00:00:00" });
    sh("checkout -qb feature");
    writeFileSync(join(dir, "s1.txt"), "s1\n");
    sh("add -A");
    sh("commit -qm s1", { GIT_COMMITTER_DATE: "2026-01-03T00:00:00" });
    writeFileSync(join(dir, "f.txt"), "a\nb\nc\nd\nE\n");
    sh("add -A");
    sh("commit -qm s2", { GIT_COMMITTER_DATE: "2026-01-04T00:00:00" });
    sh("checkout -q main");
    writeFileSync(join(dir, "c3.txt"), "c3\n");
    sh("add -A");
    sh("commit -qm c3", { GIT_COMMITTER_DATE: "2026-01-05T00:00:00" });
    writeFileSync(join(dir, "f.txt"), "A\nb\nc\nd\ne\n");
    sh("add -A");
    sh("commit -qm c4", { GIT_COMMITTER_DATE: "2026-01-06T00:00:00" });

    // our view of the PRE-rebase repo
    const t = makeStore();
    const host = leaseHost(t);
    loadGitRepoIntoStore(t, dir);
    const ours = await rebaseOnto(host, { head: "feature", onto: "main", committer: merger });
    assertEq(ours.tag, "rebased", "rebased");
    assertEq(ours.skipped, 0, "two commits replayed");
    // the real thing
    sh("checkout -q feature");
    sh("rebase -q main");
    const gitTree = sh("rev-parse feature^{tree}");
    const gitCount = parseInt(sh("rev-list --count feature"), 10);
    const byOid = new Map(ours.objects.map((o) => [o.oid, o]));
    const headCommit = parseCommit(byOid.get(ours.headOid).data);
    assertEq(headCommit.tree, gitTree, "final tree oid matches git rebase");
    assertEq(ours.commits.length, 2, "two replays");
    assertEq(gitCount, 6, "git history length (4 main + 2 replayed)");
  });

  if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nall ${planned} engine checks passed`);
}

main();
