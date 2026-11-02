/**
 * The gitlink directory-residual REFUTATION pin — the v1.5.2 ledger's D-3
 * row, adjudicated NOT a divergence before any code moved.
 *
 * The row claimed "git silently drops the gitlink delete when the path
 * becomes a directory; our flat map emits delete+add" and sketched
 * collapsing the pair in `computeDiff` (packages/git-engine src/repo.ts).
 * The claim's own declared oracle — git's own diff behavior — REFUTES it:
 * real git 2.43.0 (scratch-repo records, 2026-11-02) emits BOTH entries in
 * every mode, bare-tree and worktree alike:
 *
 *   `git diff-tree -r <gitlink-tree> <directory-tree>`
 *     :160000 000000 1234567… 0000000 D	sub
 *     :000000 100644 0000000 45b983b A	sub/file.md
 *   `git diff HEAD^ HEAD` renders the same pair as a patch
 *   (`deleted file mode 160000` + `new file mode 100644`), and the
 *   reverse direction (directory → gitlink) records `A sub` + `D
 *   sub/file.md` identically.
 *
 * Our flat map already mirrors that shape exactly — the delete-and-add pair
 * IS git's shape, so the collapse sketch would have introduced the very
 * divergence the row warns about. This file pins the verified shape on a
 * LIVE engine cell (both directions) so a future pass cannot re-introduce
 * the collapse under the stale ledger wording.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { serializeCommit, serializeTree, type ApiObject, type Person } from "@cf-gitea/git-engine";

import { branchRef, commitApiChangeError, engineReads, ZERO_OID } from "./engine";
import { buildBlobObject } from "./git-models";

const OWNER = "d3probe";
const SLUG = "d3cell";
const SUB_FAKE = "1234567890123456789012345678901234567890";
const PERSON: Person = { name: "d3", email: "d3@api.invalid", time: 1_700_000_100, tz: "+0000" };

/** The gitlink→directory history on a bare cell (rowless, name-addressed —
 *  the mirror cells' convention; the diff reads never touch D1). */
async function seedDirection(from: "gitlink" | "directory"): Promise<void> {
  const cell = env.REPO.getByName(`${OWNER}/${SLUG}`);
  const encoder = new TextEncoder();
  const innerBlob = await buildBlobObject(encoder.encode("hi\n"));
  const innerTree = serializeTree([{ mode: "100644", name: "file.md", oid: innerBlob.oid }]);
  const treeGitlink = serializeTree([{ mode: "160000", name: "sub", oid: SUB_FAKE }]);
  const treeDirectory = serializeTree([{ mode: "40000", name: "sub", oid: innerTree.oid }]);
  const baseTree = from === "gitlink" ? treeGitlink : treeDirectory;
  const tipTree = from === "gitlink" ? treeDirectory : treeGitlink;
  const root = serializeCommit({ tree: baseTree.oid, parents: [], author: PERSON, committer: PERSON, message: "base: sub at the from-shape\n" });
  const child = serializeCommit({ tree: tipTree.oid, parents: [root.oid], author: PERSON, committer: PERSON, message: "sub flips shape\n" });
  const objects: ApiObject[] = [
    innerBlob,
    { oid: innerTree.oid, type: innerTree.type, data: innerTree.data },
    { oid: treeGitlink.oid, type: treeGitlink.type, data: treeGitlink.data },
    { oid: treeDirectory.oid, type: treeDirectory.type, data: treeDirectory.data },
    { oid: root.oid, type: root.type, data: root.data },
    { oid: child.oid, type: child.type, data: child.data },
  ];
  const put = await cell.putApiObjects(objects);
  expect(put.tag).toBe("ok");
  const landed = await cell.commitApiChange({ ref: branchRef(`d3-${from}`), expectedOldOid: ZERO_OID, newOid: child.oid });
  if (landed.tag !== "committed") throw commitApiChangeError(landed);
  return;
}

describe("the gitlink directory-residual refutation (the v1.5.2 ledger's D-3)", () => {
  it("emits git's delete+add pair when a gitlink path becomes a directory (real-git diff-tree record)", async () => {
    await seedDirection("gitlink");
    const reads = engineReads(env, { ownerNamespace: OWNER, slug: SLUG });
    const diff = await reads.readDiff(branchRef("d3-gitlink"));
    if (diff === null) throw new Error("d3-gitlink diff missing: broken fixture, not an arm under test");
    // git 2.43.0 `git diff-tree -r` record: D sub + A sub/file.md — the
    // delete is NOT silently dropped, so our flat map's pair IS git's shape.
    expect(diff.files.map((f) => f.path)).toEqual(["sub", "sub/file.md"]);
    const [gitlink, added] = diff.files;
    expect(gitlink).toMatchObject({
      old: { oid: SUB_FAKE, mode: "160000" },
      new: null,
      kind: "text",
      add: 0,
      del: 1,
    });
    expect(gitlink?.hunks).toEqual([
      { aStart: 1, aLen: 1, bStart: 0, bLen: 0, ops: [{ tag: "del", line: `Subproject commit ${SUB_FAKE}` }] },
    ]);
    expect(added?.old).toBeNull();
    expect(added?.new).not.toBeNull();
    expect(added).toMatchObject({ kind: "text", add: 1, del: 0 });
    expect(added?.hunks).toEqual([
      { aStart: 0, aLen: 0, bStart: 1, bLen: 1, ops: [{ tag: "add", line: "hi" }] },
    ]);
  });

  it("emits git's add+delete pair in the reverse direction (directory becomes a gitlink)", async () => {
    await seedDirection("directory");
    const reads = engineReads(env, { ownerNamespace: OWNER, slug: SLUG });
    const diff = await reads.readDiff(branchRef("d3-directory"));
    if (diff === null) throw new Error("d3-directory diff missing: broken fixture, not an arm under test");
    // the scratch record's reverse rows: `A sub` + `D sub/file.md`
    expect(diff.files.map((f) => f.path)).toEqual(["sub", "sub/file.md"]);
    const [gitlink, deleted] = diff.files;
    expect(gitlink).toMatchObject({
      old: null,
      new: { oid: SUB_FAKE, mode: "160000" },
      add: 1,
      del: 0,
    });
    expect(deleted?.new).toBeNull();
    expect(deleted).toMatchObject({ add: 0, del: 1 });
  });
});
