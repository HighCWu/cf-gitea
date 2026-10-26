/**
 * The blob-excerpt machinery tests — each case cites the upstream behavior it
 * pins (submodule pin fc4936884584). The headline case is the port of
 * `TestBuildBlobExcerptDiffSection` (gitea/services/gitdiff/
 * gitdiff_excerpt_test.go:17-39, the 100-line "a = N" fixture, excerpt at
 * line 50, direction "up"); its chroma-inline-diff assertion
 * (gitdiff_excerpt_test.go:37-38) stays upstream-only — highlighting rides
 * the stage-3 HTML wave, this suite pins the window machinery.
 *
 * Pure unit suite: no bindings, no D1 — the excerpt builder consumes decoded
 * blob text and round-tripped anchor options, exactly what the stage-3 route
 * will hand it (compare.go:706-795).
 */

import { describe, expect, it } from "vitest";

import {
  BLOB_EXCERPT_CHUNK_SIZE,
  MAX_DISPLAY_FILE_SIZE,
  blobExcerptQuery,
  buildBlobExcerptSection,
  fillHiddenCommentIds,
  getExpandDirection,
  hashFilePathForWebUI,
  scanLines,
  sectionInfoForHunkStart,
  type BlobExcerptLine,
  type BlobExcerptOptions,
} from "./blob-excerpt";

/** The upstream test fixture: N lines of `a = <i>` (gitdiff_excerpt_test.go:18-21). */
function linesFile(count: number, prefix = "a"): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i++) parts.push(`${prefix} = ${i}`);
  return `${parts.join("\n")}\n`;
}

function opts(partial: Partial<BlobExcerptOptions>): BlobExcerptOptions {
  return {
    lastLeft: 0,
    lastRight: 0,
    leftIndex: 0,
    rightIndex: 0,
    leftHunkSize: 0,
    rightHunkSize: 0,
    direction: "single",
    language: "",
    ...partial,
  };
}

function plainRows(section: { lines: BlobExcerptLine[] }): BlobExcerptLine[] {
  return section.lines.filter((line) => line.type === "plain");
}

function expanderRow(section: { lines: BlobExcerptLine[] }): BlobExcerptLine | undefined {
  return section.lines.find((line) => line.type === "section");
}

describe("buildBlobExcerptSection — the upstream port case", () => {
  // gitdiff_excerpt_test.go:24-35 — 100 lines, excerpt anchored at the middle
  // line 50, direction "up", LastLeft/LastRight zero (file-start gap).
  it("expands the 20 lines above the anchor and prepends an 'up' expander", () => {
    const section = buildBlobExcerptSection(
      "a.py",
      linesFile(100),
      opts({ leftIndex: 50, rightIndex: 50, leftHunkSize: 10, rightHunkSize: 10, direction: "up", language: "Python" }),
    );
    // remaining = 50 > 20 → partial up: indices shift to 30, residual hunk grows to 30
    expect(section.lines).toHaveLength(BLOB_EXCERPT_CHUNK_SIZE + 1);
    const expander = section.lines[0] as BlobExcerptLine;
    expect(expander.type).toBe("section");
    expect(expander.content).toBe("@@ -30,30 +30,30 @@"); // gitdiff_excerpt.go:123
    expect(expander.sectionInfo).toEqual({
      path: "a.py",
      lastLeftIdx: 0, // the ORIGINAL last indices survive on the row (:77-82)
      lastRightIdx: 0,
      leftIdx: 30,
      rightIdx: 30,
      leftHunkSize: 30,
      rightHunkSize: 30,
    });
    expect(getExpandDirection(expander.sectionInfo as NonNullable<BlobExcerptLine["sectionInfo"]>)).toBe("up");
    // rows 30..49, left == right (unchanged region, 1:1 mapping via :46-47)
    const rows = plainRows(section);
    expect(rows).toHaveLength(BLOB_EXCERPT_CHUNK_SIZE);
    expect(rows[0]).toMatchObject({ leftIdx: 30, rightIdx: 30, content: " a = 30" });
    expect(rows[19]).toMatchObject({ leftIdx: 49, rightIdx: 49, content: " a = 49" });
    // the upstream test's highlighted-lines assertions (:33-35) — line 30 and
    // line 49 (1-based) are the window ends; the highlight source here carries
    // them, keyed for the stage-3 highlighter
    expect(section.language).toBe("Python");
    expect(section.highlightSource.startsWith("a = 1\n")).toBe(true); // buf scans FROM LINE 1 (:34-42)
    expect(section.highlightSource.endsWith("a = 49\n")).toBe(true);
    expect(section.highlightTruncated).toBe(false);
  });
});

describe("buildBlobExcerptSection — window branches", () => {
  it("partial 'down' renders below the last row, appends the expander, keeps the residual hunk", () => {
    // :83-86 — window Last+1..Last+20, last += 20, idx/hunkSizes unchanged
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(100),
      opts({ lastLeft: 10, lastRight: 10, leftIndex: 100, rightIndex: 100, leftHunkSize: 90, rightHunkSize: 90, direction: "down" }),
    );
    expect(plainRows(section).map((row) => row.rightIdx)).toEqual(
      Array.from({ length: 20 }, (_, i) => 11 + i),
    );
    expect(section.lines).toHaveLength(21);
    expect(section.lines[0]).toMatchObject({ rightIdx: 11, content: " a = 11" });
    const expander = section.lines[20] as BlobExcerptLine; // APPENDED for "down"
    expect(expander.type).toBe("section");
    expect(expander.content).toBe("@@ -100,90 +100,90 @@");
    expect(expander.sectionInfo).toMatchObject({ lastLeftIdx: 30, lastRightIdx: 30, leftIdx: 100, rightIdx: 100 });
    // residual gap 69 > 20 with hunk > 0 → both buttons (gitdiff.go:211-212)
    expect(getExpandDirection(expander.sectionInfo as NonNullable<BlobExcerptLine["sectionInfo"]>)).toBe("updown");
  });

  it("full-fills a 'single' merge of a small middle gap and emits NO expander", () => {
    // :87-103 — remaining 8 ≤ 20, "single": expand remaining-1 = 7 (both
    // anchors already rendered), then zero everything (:101-103)
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(100),
      opts({ lastLeft: 10, lastRight: 10, leftIndex: 18, rightIndex: 18, leftHunkSize: 8, rightHunkSize: 8, direction: "single" }),
    );
    const rows = plainRows(section);
    expect(rows.map((row) => row.rightIdx)).toEqual([11, 12, 13, 14, 15, 16, 17]);
    expect(expanderRow(section)).toBeUndefined();
    expect(section.highlightSource.endsWith("a = 17\n")).toBe(true);
  });

  it("full-fills an 'up' merge at the file top with remaining-1 lines (the :90 comment case)", () => {
    // "top: last=0, idx=11 ... need to expand 10 lines (1-10), so -1"
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(100),
      opts({ leftIndex: 11, rightIndex: 11, leftHunkSize: 11, rightHunkSize: 11, direction: "up" }),
    );
    expect(plainRows(section).map((row) => row.rightIdx)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(expanderRow(section)).toBeUndefined();
  });

  it("full-fills a 'down' merge at the file bottom with remaining lines (the :96 comment case)", () => {
    // tail-section shape: hunk sizes 0, rightIdx = EOF line count
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(100),
      opts({ lastLeft: 95, lastRight: 95, leftIndex: 100, rightIndex: 100, direction: "down" }),
    );
    expect(plainRows(section).map((row) => row.rightIdx)).toEqual([96, 97, 98, 99, 100]);
    expect(expanderRow(section)).toBeUndefined();
  });

  it("partially expands a bottom tail and the residual row stays 'down' (hunk sizes still 0)", () => {
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(100),
      opts({ lastLeft: 60, lastRight: 60, leftIndex: 100, rightIndex: 100, direction: "down" }),
    );
    expect(plainRows(section).map((row) => row.rightIdx)).toEqual(
      Array.from({ length: 20 }, (_, i) => 61 + i),
    );
    const expander = expanderRow(section) as BlobExcerptLine;
    expect(expander.content).toBe("@@ -100,0 +100,0 @@"); // sizes unchanged (still 0) — upstream Sprintf of zeros
    // rightHunkSize 0 → never "updown" (gitdiff.go:211), falls to "down" (:213-214)
    expect(getExpandDirection(expander.sectionInfo as NonNullable<BlobExcerptLine["sectionInfo"]>)).toBe("down");
  });

  it("degrades to an empty window when remainingLines <= 0 (no crash, no expander)", () => {
    // upstream loop no-ops (rightLineIdx < rightStart+chunk underflows the
    // window) but STILL burns the scan into the highlight buf — both pinned
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(100),
      opts({ lastLeft: 10, lastRight: 10, leftIndex: 5, rightIndex: 5, direction: "single" }),
    );
    expect(section.lines).toHaveLength(0);
    expect(section.highlightSource).toBe("a = 1\na = 2\na = 3\na = 4\n"); // scanned 1..lastRight-1, emitted none
  });

  it("keeps the expander even when the file ends before the window (no EOF guard upstream)", () => {
    // :77-82 has no EOF check — the expander ships with zero rows; pinned as
    // the faithful (quirky) behavior the stage-3 fragment will render
    const section = buildBlobExcerptSection(
      "f.txt",
      linesFile(10),
      opts({ leftIndex: 50, rightIndex: 50, leftHunkSize: 50, rightHunkSize: 50, direction: "up" }),
    );
    expect(plainRows(section)).toHaveLength(0);
    const expander = expanderRow(section) as BlobExcerptLine;
    expect(expander.content).toBe("@@ -30,70 +30,70 @@");
    expect(getExpandDirection(expander.sectionInfo as NonNullable<BlobExcerptLine["sectionInfo"]>)).toBe("up");
  });
});

describe("buildBlobExcerptSection — line splitting", () => {
  it("strips \\r\\n per line like bufio.ScanLines (NewGitDiffScanner)", () => {
    expect(scanLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    const section = buildBlobExcerptSection(
      "f.txt",
      "x = 1\r\nx = 2\r\n",
      opts({ leftIndex: 3, rightIndex: 3, direction: "single" }),
    );
    expect(plainRows(section).map((row) => row.content)).toEqual([" x = 1", " x = 2"]);
    expect(section.highlightSource).toBe("x = 1\nx = 2\n");
  });

  it("keeps a final unterminated line and newline-terminates every highlight-source line", () => {
    // fillExcerptLines writes line + '\n' unconditionally (:40-42)
    const section = buildBlobExcerptSection("f.txt", "a\nb", opts({ leftIndex: 3, rightIndex: 3, direction: "single" }));
    expect(plainRows(section).map((row) => row.content)).toEqual([" a", " b"]);
    expect(section.highlightSource).toBe("a\nb\n");
  });
});

describe("buildBlobExcerptSection — highlight-source byte cap", () => {
  it("stops buffering at MaxDisplayFileSize but still emits the window rows", () => {
    // 3000 lines x 4096 bytes ≈ 12.3 MB; a window at line ~2900 scans past
    // the 8 MiB cap (setting/ui.go:98) around line 2048
    const fat = `${Array.from({ length: 3000 }, () => "y".repeat(4095)).join("\n")}\n`;
    const section = buildBlobExcerptSection(
      "big.bin",
      fat,
      opts({ lastLeft: 2900, lastRight: 2900, leftIndex: 2950, rightIndex: 2950, direction: "down" }),
    );
    expect(section.lines).toHaveLength(21); // 20 rows + appended expander — rows survive the cap
    expect(plainRows(section)[0]).toMatchObject({ rightIdx: 2901, content: ` ${"y".repeat(4095)}` });
    expect(section.highlightTruncated).toBe(true);
    expect(section.highlightSource.length).toBeGreaterThan(MAX_DISPLAY_FILE_SIZE - 4096);
    expect(section.highlightSource.length).toBeLessThanOrEqual(MAX_DISPLAY_FILE_SIZE);
  });
});

describe("fillHiddenCommentIds", () => {
  it("collects comment IDs strictly inside the hidden right-side range (gitdiff.go:267-292)", () => {
    const line: BlobExcerptLine = {
      type: "section",
      leftIdx: 0,
      rightIdx: 0,
      content: "@@ -30,50 +30,50 @@",
      sectionInfo: {
        path: "f.txt",
        lastLeftIdx: 10,
        lastRightIdx: 10,
        leftIdx: 30,
        rightIdx: 30,
        leftHunkSize: 50,
        rightHunkSize: 50,
      },
    };
    const comments = new Map<number, Array<{ id: number }>>([
      [5, [{ id: 1 }]], // below the gap — excluded
      [10, [{ id: 2 }]], // == lastRightIdx (the rendered anchor) — excluded (:281 strict >)
      [11, [{ id: 101 }]],
      [15, [{ id: 102 }, { id: 103 }]],
      [29, [{ id: 104 }]],
      [30, [{ id: 105 }]], // == rightIdx with hunk > 0 — EXCLUDED (:283 strict <)
      [31, [{ id: 106 }]], // beyond the gap — excluded
      [-7, [{ id: 107 }]], // left-side — BLOB-EXCERPT-COMMENT-RIGHT skip (:275-277)
    ]);
    fillHiddenCommentIds(line, comments);
    // upstream iterates a Go map (unspecified order) — compare as a set
    expect([...(line.sectionInfo?.hiddenCommentIds ?? [])].sort((a, b) => a - b)).toEqual([101, 102, 103, 104]);
  });

  it("includes rightIdx itself for the end-of-file expansion (rightHunkSize == 0)", () => {
    const line: BlobExcerptLine = {
      type: "section",
      leftIdx: 0,
      rightIdx: 0,
      content: "",
      sectionInfo: {
        path: "f.txt",
        lastLeftIdx: 10,
        lastRightIdx: 10,
        leftIdx: 30,
        rightIdx: 30,
        leftHunkSize: 0,
        rightHunkSize: 0,
      },
    };
    fillHiddenCommentIds(
      line,
      new Map<number, Array<{ id: number }>>([
        [29, [{ id: 201 }]],
        [30, [{ id: 202 }]], // :282 — inclusive at EOF
      ]),
    );
    expect(line.sectionInfo?.hiddenCommentIds).toEqual([201, 202]);
  });

  it("leaves plain rows untouched", () => {
    const line: BlobExcerptLine = { type: "plain", leftIdx: 1, rightIdx: 1, content: " x" };
    fillHiddenCommentIds(line, new Map([[1, [{ id: 9 }]]]));
    expect(line.sectionInfo).toBeUndefined();
  });
});

describe("getExpandDirection", () => {
  const info = (extra: Partial<NonNullable<BlobExcerptLine["sectionInfo"]>>): NonNullable<BlobExcerptLine["sectionInfo"]> => ({
    path: "f.txt",
    lastLeftIdx: 0,
    lastRightIdx: 0,
    leftIdx: 0,
    rightIdx: 0,
    leftHunkSize: 0,
    rightHunkSize: 0,
    ...extra,
  });

  it("answers '' when the anchors are adjacent (a parsed @@ hunk header row, gap 1)", () => {
    // the parser's section rows: Last = start - 1 (gitdiff.go:1053-1054) —
    // the doc example at gitdiff.go:102-115: 17|31 @@ -40,23 +54,7 @@ 40|54
    expect(getExpandDirection(info({ lastLeftIdx: 39, lastRightIdx: 53, leftIdx: 40, rightIdx: 54, leftHunkSize: 23, rightHunkSize: 7 }))).toBe("");
  });

  it("answers up / updown / down / single per gitdiff.go:209-216", () => {
    expect(getExpandDirection(info({ leftIdx: 30, rightIdx: 30 }))).toBe("up"); // last <= 0
    expect(getExpandDirection(info({ lastLeftIdx: 100, lastRightIdx: 100, leftIdx: 130, rightIdx: 130, leftHunkSize: 70, rightHunkSize: 70 }))).toBe("updown");
    expect(getExpandDirection(info({ lastLeftIdx: 80, lastRightIdx: 80, leftIdx: 100, rightIdx: 100 }))).toBe("down"); // sizes 0
    expect(getExpandDirection(info({ lastLeftIdx: 100, lastRightIdx: 100, leftIdx: 110, rightIdx: 110, leftHunkSize: 90, rightHunkSize: 90 }))).toBe("single");
    // gap 30 > 20 but rightHunkSize 0 → skips "updown" (:211's && hunk > 0)
    expect(getExpandDirection(info({ lastLeftIdx: 80, lastRightIdx: 80, leftIdx: 110, rightIdx: 110 }))).toBe("down");
  });
});

describe("blobExcerptQuery", () => {
  it("renders the round-trip form fields of gitdiff.go:189-203 over the :102-115 example", () => {
    const query = blobExcerptQuery(
      {
        path: "a b.py",
        lastLeftIdx: 17,
        lastRightIdx: 31,
        leftIdx: 40,
        rightIdx: 54,
        leftHunkSize: 23,
        rightHunkSize: 7,
      },
      "Python",
    );
    expect(query).toBe(
      "last_left=17&last_right=31&left=40&right=54&left_hunk_size=23&right_hunk_size=7&path=a%20b.py&filelang=Python",
    );
    // space is %20 (encodeURIComponent) vs Go QueryEscape's "+" — the one
    // documented divergence; decodes identically server-side
    expect(query).not.toContain("+");
  });
});

describe("hashFilePathForWebUI", () => {
  it("matches the upstream SHA-1 hex vector (utils_test.go:14-17)", async () => {
    await expect(hashFilePathForWebUI("foobar")).resolves.toBe("8843d7f92416211de9ebb963ff4ce28125932878");
  });

  it("hashes the empty path and non-ASCII paths to 40 lowercase hex chars", async () => {
    await expect(hashFilePathForWebUI("")).resolves.toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709"); // SHA-1("")
    const hex = await hashFilePathForWebUI("src/文.py");
    expect(hex).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("sectionInfoForHunkStart", () => {
  it("bridges an engine Hunk to the parser's @@ section row (Last = start - 1)", () => {
    const info = sectionInfoForHunkStart("f.txt", { aStart: 40, aLen: 23, bStart: 54, bLen: 7 }, 39, 53);
    expect(info).toEqual({
      path: "f.txt",
      lastLeftIdx: 39,
      lastRightIdx: 53,
      leftIdx: 40,
      rightIdx: 54,
      leftHunkSize: 23,
      rightHunkSize: 7,
    });
    expect(getExpandDirection(info)).toBe(""); // hunk-header rows carry no button (gap 1)
  });
});
