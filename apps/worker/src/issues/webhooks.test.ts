/**
 * Tests for the push-payload commit file-list enrichment (§2.7
 * PayloadCommit.added/removed/modified — the mirror-wave deviation #2).
 *
 * The classification unit tests pin the port of upstream's
 * GetCommitFileStatus letter mapping (modules/git/commit_file.go:57-64,
 * `--no-renames`: a rename is removed+added, a typechange is dropped). The
 * engine-backed tests run the enrichment against a REAL RepoCell — a
 * five-commit chain (root / modify / delete / rename / typechange) landed on
 * refs/heads/main through the same public RPCs the push and mirror paths
 * read — pinning per-commit first-parent diffing, the one-readDiff-per-commit
 * cost cap, and the best-effort degradation (a failed diff read returns the
 * input array untouched and never throws).
 */

import { serializeCommit, serializeTree, type ApiObject, type DiffFileJson } from "@cf-gitea/git-engine";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { commitFileLists, enrichCommitsWithFileLists, type CommitDiffRead } from "./webhooks";

// ---------------------------------------------------------------------------
// commitFileLists — the classification port (pure, no engine)
// ---------------------------------------------------------------------------

/** Minimal DiffFileJson builder — the fields the classifier reads are old/new/path. */
function file(path: string, oldEntry: { oid: string; mode: string } | null, newEntry: { oid: string; mode: string } | null): DiffFileJson {
  return { path, old: oldEntry, new: newEntry, kind: "text", add: 1, del: 1, hunks: [] };
}

const MODE = { oidA: "1111111111111111111111111111111111111111", oidB: "2222222222222222222222222222222222222222" };

describe("commitFileLists (upstream --no-renames letter port)", () => {
  it("maps added/removed/modified by diff side", () => {
    const lists = commitFileLists([
      file("new.txt", null, { oid: MODE.oidA, mode: "100644" }),
      file("gone.txt", { oid: MODE.oidA, mode: "100644" }, null),
      file("kept.txt", { oid: MODE.oidA, mode: "100644" }, { oid: MODE.oidB, mode: "100644" }),
    ]);
    expect(lists).toEqual({ added: ["new.txt"], removed: ["gone.txt"], modified: ["kept.txt"] });
  });

  it("classifies a rename as removed(old) + added(new) — never modified (--no-renames)", () => {
    const lists = commitFileLists([
      file("old.txt", { oid: MODE.oidA, mode: "100644" }, null),
      file("new.txt", null, { oid: MODE.oidA, mode: "100644" }),
    ]);
    expect(lists).toEqual({ added: ["new.txt"], removed: ["old.txt"], modified: [] });
  });

  it("keeps content changes and exec-bit-only changes as modified", () => {
    const lists = commitFileLists([
      file("script.sh", { oid: MODE.oidA, mode: "100644" }, { oid: MODE.oidA, mode: "100755" }),
      file("doc.md", { oid: MODE.oidA, mode: "100644" }, { oid: MODE.oidB, mode: "100644" }),
    ]);
    expect(lists.modified).toEqual(["script.sh", "doc.md"]);
    expect(lists.added).toEqual([]);
    expect(lists.removed).toEqual([]);
  });

  it("drops typechanges (upstream letter T has no case in parseCommitFileStatus)", () => {
    const lists = commitFileLists([file("link", { oid: MODE.oidA, mode: "100644" }, { oid: MODE.oidB, mode: "120000" })]);
    expect(lists).toEqual({ added: [], removed: [], modified: [] });
  });

  it("always carries all three arrays, empty when nothing maps", () => {
    const lists = commitFileLists([]);
    expect(Object.keys(lists).sort()).toEqual(["added", "modified", "removed"]);
    expect(lists).toEqual({ added: [], removed: [], modified: [] });
  });
});

// ---------------------------------------------------------------------------
// enrichCommitsWithFileLists — against a REAL repo cell (five-commit chain)
// ---------------------------------------------------------------------------

/** Worker-side object hash (putApiObjects re-verifies; the pulls.test.ts pattern). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PERSON = { name: "filelists-test", email: "filelists@issues.invalid", time: 1761000000, tz: "+0000" };

/** Tree entry builder — text blob content hashed and stored with the tree. */
async function textEntry(name: string, content: string, mode = "100644"): Promise<{ name: string; mode: string; oid: string; data: Uint8Array }> {
  const data = new TextEncoder().encode(content);
  return { name, mode, oid: await gitObjectOid("blob", data), data };
}

interface ChainCommit {
  id: string;
  message: string;
}

describe("enrichCommitsWithFileLists (real RepoCell)", () => {
  let cell: Awaited<ReturnType<typeof repoCell>>;
  let root: ChainCommit;
  let modify: ChainCommit;
  let deletion: ChainCommit;
  let rename: ChainCommit;
  let typechange: ChainCommit;

  /**
   * One commit landed on refs/heads/main via putApiObjects + commitApiChange
   * (the public write RPCs; bare-oid readDiff inputs must be ref-reachable).
   */
  async function landCommit(
    ref: string,
    baseTip: string | null,
    entries: Array<{ name: string; mode: string; oid: string; data: Uint8Array }>,
    message: string,
    parents: string[],
  ): Promise<ChainCommit> {
    const objects: ApiObject[] = [];
    for (const entry of entries) {
      objects.push({ oid: entry.oid, type: "blob", data: entry.data });
    }
    const tree = serializeTree(entries.map(({ name, mode, oid }) => ({ name, mode, oid })));
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    const commit = serializeCommit({ tree: tree.oid, parents, author: PERSON, committer: PERSON, message });
    objects.push({ oid: commit.oid, type: commit.type, data: commit.data });
    const put = await cell.putApiObjects(objects);
    if (put.tag !== "ok") {
      throw new Error(`putApiObjects failed: ${put.tag}`);
    }
    const cas = await cell.commitApiChange({ ref, expectedOldOid: baseTip ?? "0000000000000000000000000000000000000000", newOid: commit.oid });
    if (cas.tag !== "committed") {
      throw new Error(`commitApiChange failed: ${cas.tag}`);
    }
    return { id: commit.oid, message };
  }

  function repoCell() {
    return env.REPO.getByName("issues-filelists/scratch");
  }

  beforeAll(async () => {
    cell = repoCell();
    const ref = "refs/heads/main";

    // c1 — ROOT commit: three files (root diffs against the empty tree).
    root = await landCommit(
      ref,
      null,
      [await textEntry("a.txt", "one\n"), await textEntry("b.txt", "two\n"), await textEntry("old.txt", "three\n")],
      "root\n",
      [],
    );
    // c2 — modification: a.txt content change, b.txt/old.txt untouched.
    modify = await landCommit(ref, root.id, [await textEntry("a.txt", "one-changed\n"), await textEntry("b.txt", "two\n"), await textEntry("old.txt", "three\n")], "modify a\n", [root.id]);
    // c3 — deletion: b.txt gone.
    deletion = await landCommit(ref, modify.id, [await textEntry("a.txt", "one-changed\n"), await textEntry("old.txt", "three\n")], "delete b\n", [modify.id]);
    // c4 — rename per --no-renames: old.txt removed, new.txt added (same content).
    rename = await landCommit(ref, deletion.id, [await textEntry("a.txt", "one-changed\n"), await textEntry("new.txt", "three\n")], "rename old to new\n", [deletion.id]);
    // c5 — typechange: a.txt becomes a symlink (upstream letter T — dropped).
    typechange = await landCommit(ref, rename.id, [await textEntry("a.txt", "new.txt", "120000"), await textEntry("new.txt", "three\n")], "typechange a\n", [rename.id]);
  });

  it("enriches a root commit: every file added, none removed/modified", async () => {
    const result = await enrichCommitsWithFileLists([{ id: root.id }], (id) => cell.readDiff(id));
    if (!result.enriched) throw new Error("expected enrichment to succeed");
    expect(result.commits[0]?.added.sort()).toEqual(["a.txt", "b.txt", "old.txt"]);
    expect(result.commits[0]?.removed).toEqual([]);
    expect(result.commits[0]?.modified).toEqual([]);
  });

  it("enriches the newest-first payload window: per-commit first-parent lists, order preserved", async () => {
    const payload = [
      { id: typechange.id, message: typechange.message },
      { id: rename.id, message: rename.message },
      { id: deletion.id, message: deletion.message },
    ];
    const result = await enrichCommitsWithFileLists(payload, (id) => cell.readDiff(id));
    if (!result.enriched) throw new Error("expected enrichment to succeed");
    expect(result.commits.map((commit) => commit.id)).toEqual(payload.map((commit) => commit.id));

    // c5 — the symlink typechange is dropped from all three lists.
    expect(result.commits[0]).toEqual({ id: typechange.id, message: typechange.message, added: [], removed: [], modified: [] });
    // c4 — the rename is removed(old)+added(new).
    expect(result.commits[1]?.added).toEqual(["new.txt"]);
    expect(result.commits[1]?.removed).toEqual(["old.txt"]);
    expect(result.commits[1]?.modified).toEqual([]);
    // c3 — the deletion.
    expect(result.commits[2]?.removed).toEqual(["b.txt"]);
    expect(result.commits[2]?.added).toEqual([]);
    expect(result.commits[2]?.modified).toEqual([]);
  });

  it("costs exactly one readDiff per commit, each with that commit's own id", async () => {
    const calls: string[][] = [];
    const countingRead: CommitDiffRead = async (id) => {
      calls.push([id]);
      return cell.readDiff(id);
    };
    const payload = [{ id: rename.id }, { id: modify.id }, { id: root.id }];
    const result = await enrichCommitsWithFileLists(payload, countingRead);
    if (!result.enriched) throw new Error("expected enrichment to succeed");
    expect(calls).toEqual([[rename.id], [modify.id], [root.id]]);
    // c2 — the mid-chain modification.
    expect(result.commits[1]?.modified).toEqual(["a.txt"]);
    expect(result.commits[1]?.added).toEqual([]);
    expect(result.commits[1]?.removed).toEqual([]);
  });

  it("degrades to the current payload shape when readDiff throws", async () => {
    const payload = [{ id: rename.id }, { id: modify.id }];
    const result = await enrichCommitsWithFileLists(payload, () => {
      throw new Error("transport failure");
    });
    expect(result.enriched).toBe(false);
    expect(result.commits).toBe(payload);
    for (const commit of result.commits) {
      expect("added" in commit).toBe(false);
      expect("removed" in commit).toBe(false);
      expect("modified" in commit).toBe(false);
    }
  });

  it("degrades when readDiff resolves null (unresolvable id)", async () => {
    const payload = [{ id: rename.id }, { id: "9999999999999999999999999999999999999999" }];
    const result = await enrichCommitsWithFileLists(payload, (id) => cell.readDiff(id));
    expect(result.enriched).toBe(false);
    expect(result.commits).toBe(payload);
    expect("added" in result.commits[0]!).toBe(false);
  });
});
