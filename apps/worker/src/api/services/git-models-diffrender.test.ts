/**
 * renderUnifiedDiff / renderUnifiedDiffAsync / renderPatch byte pins — the
 * ⑫-review D1/D3 renderer fix. Every literal below is RECORDED REAL-GIT
 * OUTPUT (git 2.43, reproduced in a scratch repo at authoring time and
 * copied verbatim; the zstd.test.ts fixture discipline — the system tool is
 * the oracle, its bytes are the fixture). The contract is verbatim git bytes:
 * upstream GetPatch is documented "able to be used with `git apply`"
 * (modules/git/repo_compare.go:73-77), so each section shape here is one the
 * binary's `git apply --check` accepts (verified out-of-band — workerd tests
 * cannot spawn the binary; the recorded literals ARE the verification).
 *
 * Pinned shapes (each traced to its scratch-repo probe in the test body):
 *   - mode-only change  → `old mode`/`new mode` and NOTHING else (no index,
 *     no ---/+++, no hunks) — headers-only sections are git-apply GARBAGE;
 *   - index-line mode column only when both sides share the mode (new:
 *     `index 0000000..422c2b7`; deleted: `index 422c2b7..0000000`; mode
 *     change: bare `index d95f3ad..637f034`);
 *   - created/deleted EMPTY blob → header + index and stop;
 *   - hunk headers omit `,1` (`@@ -1 +1,2 @@`, `@@ -1 +1 @@`);
 *   - the no-newline marker after the emitted line that is the file's last
 *     line when that side's blob lacks the trailing newline (async arm);
 *   - trailing-newline-only change (the engine's zero-hunk shape) → the full
 *     synthesized hunk with the marker on the newline-lacking side;
 *   - the terminal-eq rewrite (engine eq at the old file's final line where
 *     the old blob lacks the newline → git's del/add pair, header unchanged).
 */

import { describe, expect, it } from "vitest";

import type { DiffFileJson } from "@cf-gitea/git-engine";

import {
  NO_NEWLINE_MARKER,
  renderPatch,
  renderPatchAsync,
  renderUnifiedDiff,
  renderUnifiedDiffAsync,
  type DiffBlobSource,
} from "./git-models";
import type { CommitJson } from "@cf-gitea/git-engine";

/** A text DiffFileJson with the given oids/modes/hunks. */
function textFile(overrides: Partial<DiffFileJson> & { path: string }): DiffFileJson {
  return {
    old: { oid: "587be6b1d1b3e8f78a4b06ec94e4d9dbe87be6b1", mode: "100644" },
    new: { oid: "b77b4eb8f0e83f35a4f367c33e731c4f3b7bf4eb", mode: "100644" },
    kind: "text",
    add: 0,
    del: 0,
    hunks: [],
    ...overrides,
  };
}

/** An in-memory DiffBlobSource: the NEW-tip map and the OLD-tip map separate
 *  (the renderer reads the old tree's blob for the old-side marker facts). */
function memSource(newFiles: Record<string, string>, oldFiles: Record<string, string> = newFiles): DiffBlobSource {
  return {
    oldTip: "old",
    newTip: "new",
    blobText: (tip, path) => {
      if (tip === null) return Promise.resolve(null);
      const map = tip === "old" ? oldFiles : newFiles;
      return Promise.resolve(map[path] ?? null);
    },
  };
}

// --- D3: index-line + hunk-header bytes (sync, content-free) -----------------

describe("renderUnifiedDiff — git's index/hunk header bytes (D3)", () => {
  it("mode-only change: old/new mode lines and NOTHING else (no index, no ---/+++)", () => {
    // real git (scratch repo, `git diff` after chmod +x f.txt):
    //   diff --git a/f.txt b/f.txt
    //   old mode 100644
    //   new mode 100755
    const file = textFile({
      path: "f.txt",
      old: { oid: "8b14c4f055267310b71fb4a50e5a8736644bfc28", mode: "100644" },
      new: { oid: "8b14c4f055267310b71fb4a50e5a8736644bfc28", mode: "100755" },
    });
    expect(renderUnifiedDiff([file])).toBe("diff --git a/f.txt b/f.txt\nold mode 100644\nnew mode 100755");
  });

  it("new file: the index line carries NO mode column (it rides the new-file-mode line)", () => {
    // real git: `index 0000000..422c2b7` under `new file mode 100644`
    const file = textFile({
      path: "newf.txt",
      old: null,
      new: { oid: "422c2b7ab4b6c1e1e0e8e1f3f9b1e8e1a3b4c5d6", mode: "100644" },
      hunks: [
        { aStart: 0, aLen: 0, bStart: 1, bLen: 2, ops: [
          { tag: "add", line: "a" },
          { tag: "add", line: "b" },
        ] },
      ],
    });
    expect(renderUnifiedDiff([file])).toBe(
      [
        "diff --git a/newf.txt b/newf.txt",
        "new file mode 100644",
        "index 0000000..422c2b7",
        "--- /dev/null",
        "+++ b/newf.txt",
        "@@ -0,0 +1,2 @@",
        "+a",
        "+b",
      ].join("\n"),
    );
  });

  it("deleted file: the index line carries NO mode column either", () => {
    // real git: `index 422c2b7..0000000` under `deleted file mode 100644`
    const file = textFile({
      path: "newf.txt",
      old: { oid: "422c2b7ab4b6c1e1e0e8e1f3f9b1e8e1a3b4c5d6", mode: "100644" },
      new: null,
      hunks: [
        { aStart: 1, aLen: 2, bStart: 0, bLen: 0, ops: [
          { tag: "del", line: "a" },
          { tag: "del", line: "b" },
        ] },
      ],
    });
    expect(renderUnifiedDiff([file])).toBe(
      [
        "diff --git a/newf.txt b/newf.txt",
        "deleted file mode 100644",
        "index 422c2b7..0000000",
        "--- a/newf.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-a",
        "-b",
      ].join("\n"),
    );
  });

  it("mode+content change: old/new mode lines then a BARE index line (no column)", () => {
    // real git (scratch repo, content edited + chmod 644 in one commit):
    //   diff --git a/mc.txt b/mc.txt
    //   old mode 100755
    //   new mode 100644
    //   index d95f3ad..637f034
    //   --- a/mc.txt
    //   +++ b/mc.txt
    //   @@ -1 +1 @@
    //   -content
    //   +content2
    const file = textFile({
      path: "mc.txt",
      old: { oid: "d95f3ad1e2e3e4f5a6b7c8d9e0f1a2b3c4d5e6f7", mode: "100755" },
      new: { oid: "637f034a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e", mode: "100644" },
      add: 1,
      del: 1,
      hunks: [
        { aStart: 1, aLen: 1, bStart: 1, bLen: 1, ops: [
          { tag: "del", line: "content" },
          { tag: "add", line: "content2" },
        ] },
      ],
    });
    expect(renderUnifiedDiff([file])).toBe(
      [
        "diff --git a/mc.txt b/mc.txt",
        "old mode 100755",
        "new mode 100644",
        "index d95f3ad..637f034",
        "--- a/mc.txt",
        "+++ b/mc.txt",
        "@@ -1 +1 @@",
        "-content",
        "+content2",
      ].join("\n"),
    );
  });

  it("hunk headers omit a `,1` single-line count on both sides", () => {
    // real git: a one-line file edited → `@@ -1 +1 @@`; a one-line file
    // created → `@@ -0,0 +1 @@`; context+1 → `@@ -1 +1,2 @@`
    const edited = textFile({
      path: "one.txt",
      hunks: [{ aStart: 1, aLen: 1, bStart: 1, bLen: 2, ops: [
        { tag: "eq", line: "x" },
        { tag: "add", line: "y" },
      ] }],
    });
    expect(renderUnifiedDiff([edited])).toContain("@@ -1 +1,2 @@");
    const symmetric = textFile({
      path: "sym.txt",
      hunks: [{ aStart: 1, aLen: 1, bStart: 1, bLen: 1, ops: [
        { tag: "del", line: "x" },
        { tag: "add", line: "z" },
      ] }],
    });
    expect(renderUnifiedDiff([symmetric])).toContain("@@ -1 +1 @@");
  });

  it("a created/deleted EMPTY blob: header + index and stop (no ---/+++)", () => {
    // real git: `index 0000000..e69de29` and nothing else (79 bytes total)
    const created = textFile({
      path: "empty.txt",
      old: null,
      new: { oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", mode: "100644" },
    });
    expect(renderUnifiedDiff([created])).toBe(
      "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29",
    );
    const deleted = textFile({
      path: "empty.txt",
      old: { oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", mode: "100644" },
      new: null,
    });
    expect(renderUnifiedDiff([deleted])).toBe(
      "diff --git a/empty.txt b/empty.txt\ndeleted file mode 100644\nindex e69de29..0000000",
    );
  });

  it("a normal modification keeps the mode column on the index line", () => {
    // real git: `index 587be6b..b77b4eb 100644` (both sides, same mode)
    const file = textFile({
      path: "one.txt",
      add: 1,
      hunks: [{ aStart: 1, aLen: 1, bStart: 1, bLen: 2, ops: [
        { tag: "eq", line: "x" },
        { tag: "add", line: "y" },
      ] }],
    });
    expect(renderUnifiedDiff([file])).toContain("index 587be6b..b77b4eb 100644");
  });
});

// --- D1: the async arm (markers + newline-only synthesis) --------------------

describe("renderUnifiedDiffAsync — the no-newline marker and the newline-only hunk (D1)", () => {
  it("emits the marker after the last emitted old-side line when the old blob lacks the newline", async () => {
    // real git (scratch repo): old `p\nq` (no NL), new `p\nz\n`:
    //   @@ -1,2 +1,2 @@
    //    p
    //   -q
    //   \ No newline at end of file
    //   +z
    const file = textFile({
      path: "tail.txt",
      add: 1,
      del: 1,
      hunks: [{ aStart: 1, aLen: 2, bStart: 1, bLen: 2, ops: [
        { tag: "eq", line: "p" },
        { tag: "del", line: "q" },
        { tag: "add", line: "z" },
      ] }],
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "tail.txt": "p\nz\n" }, { "tail.txt": "p\nq" }));
    expect(out).toBe(
      [
        "diff --git a/tail.txt b/tail.txt",
        "index 587be6b..b77b4eb 100644",
        "--- a/tail.txt",
        "+++ b/tail.txt",
        "@@ -1,2 +1,2 @@",
        " p",
        "-q",
        NO_NEWLINE_MARKER,
        "+z",
      ].join("\n"),
    );
  });

  it("emits the marker after the last emitted new-side line when the new blob lacks the newline", async () => {
    // real git: old `p\nq\n`, new `p\nq` (newline removed in the commit):
    //   @@ -1,2 +1,2 @@
    //    p
    //   -q
    //   +q
    //   \ No newline at end of file
    const file = textFile({
      path: "tail.txt",
      add: 1,
      del: 1,
      hunks: [{ aStart: 1, aLen: 2, bStart: 1, bLen: 2, ops: [
        { tag: "eq", line: "p" },
        { tag: "del", line: "q" },
        { tag: "add", line: "q" },
      ] }],
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "tail.txt": "p\nq" }, { "tail.txt": "p\nq\n" }));
    expect(out).toContain(`+q\n${NO_NEWLINE_MARKER}`);
    expect(out).not.toContain(`-q\n${NO_NEWLINE_MARKER}`);
  });

  it("rewrites the terminal eq op into git's del/add pair when the old side lacks the newline", async () => {
    // real git (old `p\nq` no NL, new `p\nq\nr\n` — the engine's terminator-
    // blind diff keeps `q` as one eq): the emitted shape is
    //   @@ -1,2 +1,3 @@
    //    p
    //   -q
    //   \ No newline at end of file
    //   +q
    //   +r
    // (line counts identical under the rewrite — the header stays)
    const file = textFile({
      path: "append.txt",
      add: 1,
      del: 0,
      hunks: [{ aStart: 1, aLen: 2, bStart: 1, bLen: 3, ops: [
        { tag: "eq", line: "p" },
        { tag: "eq", line: "q" },
        { tag: "add", line: "r" },
      ] }],
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "append.txt": "p\nq\nr\n" }, { "append.txt": "p\nq" }));
    expect(out).toBe(
      [
        "diff --git a/append.txt b/append.txt",
        "index 587be6b..b77b4eb 100644",
        "--- a/append.txt",
        "+++ b/append.txt",
        "@@ -1,2 +1,3 @@",
        " p",
        "-q",
        NO_NEWLINE_MARKER,
        "+q",
        "+r",
      ].join("\n"),
    );
  });

  it("does not rewrite when the terminal eq ends a newline-terminated old blob", async () => {
    const file = textFile({
      path: "plain.txt",
      add: 1,
      hunks: [{ aStart: 1, aLen: 2, bStart: 1, bLen: 3, ops: [
        { tag: "eq", line: "p" },
        { tag: "eq", line: "q" },
        { tag: "add", line: "r" },
      ] }],
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "plain.txt": "p\nq\nr\n" }));
    expect(out).toContain(" p\n q\n+r");
    expect(out).not.toContain(NO_NEWLINE_MARKER);
  });

  it("keeps the marker exact across MULTI-hunk sections with gaps between clusters", async () => {
    // real git (scratch repo, l1..l20 no trailing NL -> l1/l20 edited + NL):
    //   @@ -1,4 +1,4 @@
    //   -l1
    //   +X1
    //    l2
    //    l3
    //    l4
    //   @@ -17,4 +17,4 @@ l16
    //    l17
    //    l18
    //    l19
    //   -l20
    //   \ No newline at end of file
    //   +X20
    // (git's second header carries the funcname suffix ` l16` — the
    // documented residual). The walk positions reset PER HUNK: a running
    // counter dragged across the 12-line gap would sit at 4, not 20, when
    // the final del emitted — the marker would drop and `git apply --check`
    // would refuse the patch (pre-image mismatch on l20).
    const file = textFile({
      path: "two.txt",
      add: 2,
      del: 2,
      hunks: [
        { aStart: 1, aLen: 4, bStart: 1, bLen: 4, ops: [
          { tag: "del", line: "l1" },
          { tag: "add", line: "X1" },
          { tag: "eq", line: "l2" },
          { tag: "eq", line: "l3" },
          { tag: "eq", line: "l4" },
        ] },
        { aStart: 17, aLen: 4, bStart: 17, bLen: 4, ops: [
          { tag: "eq", line: "l17" },
          { tag: "eq", line: "l18" },
          { tag: "eq", line: "l19" },
          { tag: "del", line: "l20" },
          { tag: "add", line: "X20" },
        ] },
      ],
    });
    const oldText = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const newText = ["X1", ...Array.from({ length: 18 }, (_, i) => `l${i + 2}`), "X20"].join("\n") + "\n";
    const out = await renderUnifiedDiffAsync([file], memSource({ "two.txt": newText }, { "two.txt": oldText }));
    expect(out).toBe(
      [
        "diff --git a/two.txt b/two.txt",
        "index 587be6b..b77b4eb 100644",
        "--- a/two.txt",
        "+++ b/two.txt",
        "@@ -1,4 +1,4 @@",
        "-l1",
        "+X1",
        " l2",
        " l3",
        " l4",
        "@@ -17,4 +17,4 @@",
        " l17",
        " l18",
        " l19",
        "-l20",
        NO_NEWLINE_MARKER,
        "+X20",
      ].join("\n"),
    );
  });

  it("synthesizes the full hunk for a trailing-newline-only change (single-line file)", async () => {
    // real git (scratch repo, `only` → `only\n`):
    //   diff --git a/s.txt b/s.txt
    //   index c400566..6c542ab 100644
    //   --- a/s.txt
    //   +++ b/s.txt
    //   @@ -1 +1 @@
    //   -only
    //   \ No newline at end of file
    //   +only
    const file = textFile({
      path: "s.txt",
      old: { oid: "c4005662e6e7a9c1e1e0e8e1f3f9b1e8e1a3b4c5", mode: "100644" },
      new: { oid: "6c542ab8f0e83f35a4f367c33e731c4f3b7bf4eb", mode: "100644" },
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "s.txt": "only\n" }));
    expect(out).toBe(
      [
        "diff --git a/s.txt b/s.txt",
        "index c400566..6c542ab 100644",
        "--- a/s.txt",
        "+++ b/s.txt",
        "@@ -1 +1 @@",
        "-only",
        NO_NEWLINE_MARKER,
        "+only",
      ].join("\n"),
    );
  });

  it("synthesizes the newline-only hunk with up to three context lines (the context cap)", async () => {
    // real git (scratch repo, `a\nb\nc\nd\ne` → `a\nb\nc\nd\ne\n`):
    //   @@ -2,4 +2,4 @@ a
    //    b
    //    c
    //    d
    //   -e
    //   \ No newline at end of file
    //   +e
    // (git's hunk header carries the funcname suffix ` a` — the engine hunks
    // carry none; the documented residual. The line/count bytes are exact.)
    const file = textFile({
      path: "big.txt",
      old: { oid: "0fec236a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e", mode: "100644" },
      new: { oid: "9405329b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", mode: "100644" },
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "big.txt": "a\nb\nc\nd\ne\n" }));
    expect(out).toBe(
      [
        "diff --git a/big.txt b/big.txt",
        "index 0fec236..9405329 100644",
        "--- a/big.txt",
        "+++ b/big.txt",
        "@@ -2,4 +2,4 @@",
        " b",
        " c",
        " d",
        "-e",
        NO_NEWLINE_MARKER,
        "+e",
      ].join("\n"),
    );
  });

  it("synthesizes the newline-only hunk for a newline REMOVAL (marker on the + side)", async () => {
    // real git: `foo\nbar\n` → `foo\nbar`:
    //   @@ -1,2 +1,2 @@
    //    foo
    //   -bar
    //   +bar
    //   \ No newline at end of file
    const file = textFile({
      path: "n.txt",
      old: { oid: "3bd1f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7", mode: "100644" },
      new: { oid: "a907ec3b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", mode: "100644" },
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "n.txt": "foo\nbar" }));
    expect(out).toContain("@@ -1,2 +1,2 @@\n foo\n-bar\n+bar\n" + NO_NEWLINE_MARKER);
  });

  it("degrades to the sync shape when the blob read fails (no markers, no synthesis)", async () => {
    const newlineOnly = textFile({
      path: "ghost.txt",
      old: { oid: "3bd1f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7", mode: "100644" },
      new: { oid: "a907ec3b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", mode: "100644" },
    });
    const out = await renderUnifiedDiffAsync([newlineOnly], memSource({}));
    expect(out).toBe("diff --git a/ghost.txt b/ghost.txt\nindex 3bd1f0e..a907ec3 100644\n--- a/ghost.txt\n+++ b/ghost.txt");
    const edited = textFile({
      path: "plain.txt",
      add: 1,
      hunks: [{ aStart: 1, aLen: 1, bStart: 1, bLen: 2, ops: [
        { tag: "eq", line: "x" },
        { tag: "add", line: "y" },
      ] }],
    });
    const degraded = await renderUnifiedDiffAsync([edited], memSource({}));
    expect(degraded).toBe(renderUnifiedDiff([edited]));
  });

  it("mode+newline-only: mode lines, bare index, and the synthesized hunk", async () => {
    // the new text HAS the newline → the old side lacks it → the marker rides
    // the del (git puts it on the newline-lacking side's emitted line)
    const file = textFile({
      path: "nm.txt",
      old: { oid: "3bd1f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7", mode: "100644" },
      new: { oid: "a907ec3b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", mode: "100755" },
    });
    const out = await renderUnifiedDiffAsync([file], memSource({ "nm.txt": "foo\nbar\n" }));
    expect(out).toBe(
      [
        "diff --git a/nm.txt b/nm.txt",
        "old mode 100644",
        "new mode 100755",
        "index 3bd1f0e..a907ec3",
        "--- a/nm.txt",
        "+++ b/nm.txt",
        "@@ -1,2 +1,2 @@",
        " foo",
        "-bar",
        NO_NEWLINE_MARKER,
        "+bar",
      ].join("\n"),
    );
  });
});

// --- the mail block (patchNumber + the async twin) ---------------------------

function mailCommit(oid: string, message: string): CommitJson {
  const person = { name: "T", email: "t@t.t", time: 1_767_000_000, tz: "+0000" };
  return { oid, tree: "f" + oid.slice(1), parents: ["p" + oid.slice(1)], author: person, committer: person, message, subject: message.split("\n")[0] ?? "" };
}

describe("renderPatch — series numbering and the async twin", () => {
  it("a single mail keeps git's bare [PATCH] subject; a series numbers [PATCH i/N]", () => {
    const single = renderPatch(mailCommit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "feat\n"), [], { signature: null });
    expect(single).toContain("Subject: [PATCH] feat");
    const first = renderPatch(mailCommit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "feat\n"), [], {
      signature: null,
      patchNumber: { index: 1, count: 2 },
    });
    expect(first).toContain("Subject: [PATCH 1/2] feat");
    const second = renderPatch(mailCommit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "mainline\n"), [], {
      signature: null,
      patchNumber: { index: 2, count: 2 },
    });
    expect(second).toContain("Subject: [PATCH 2/2] mainline");
  });

  it("renderPatchAsync equals renderPatch byte-for-byte when no marker can exist", async () => {
    const commit = mailCommit("cccccccccccccccccccccccccccccccccccccccc", "subject\n\nbody\n");
    const files = [
      textFile({
        path: "one.txt",
        add: 1,
        hunks: [{ aStart: 1, aLen: 1, bStart: 1, bLen: 2, ops: [
          { tag: "eq", line: "x" },
          { tag: "add", line: "y" },
        ] }],
      }),
    ];
    const sync = renderPatch(commit, files, { signature: "2.43.0" });
    const asynced = await renderPatchAsync(commit, files, memSource({ "one.txt": "x\ny\n" }), { signature: "2.43.0" });
    expect(asynced).toBe(sync);
  });
});
