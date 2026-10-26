/**
 * The blob-excerpt machinery — the Worker-side port of upstream
 * `services/gitdiff/gitdiff_excerpt.go` (submodule pin fc4936884584): the
 * hunk-window expansion behind the PR diff view's "expand N lines" buttons.
 *
 * WHICH INPUTS (a common misreading, stated up front): the excerpt is NOT cut
 * from a diff. `ExcerptBlob` (routers/web/repo/compare.go:706-795) reads the
 * BLOB at the after-commit for `path` and hands its bytes to
 * `BuildBlobExcerptDiffSection` (gitdiff_excerpt.go:63) together with anchor
 * options the template round-trips from the previously rendered expander row
 * (`last_left`/`last_right` = the last rendered line numbers before the
 * hidden gap, `left`/`right` = the first rendered line numbers after it,
 * `left_hunk_size`/`right_hunk_size` = the residual @@ hunk sizes, and
 * `direction` = which button was clicked). Every emitted row is a PLAIN
 * (context) row — the hidden gap is an unchanged region shared by both diff
 * sides — so right-side line numbers map to left-side ones by a constant
 * offset carried in the options.
 *
 * WINDOW SEMANTICS (each branch cited to gitdiff_excerpt.go:76-104):
 *   - remainingLines = RightIndex - LastRight (the hidden line count);
 *     expandLimit = BlobExcerptChunkSize = 20 (gitdiff.go:134).
 *   - direction "up"  AND remaining > 20 (partial, :77-82): the window is the
 *     20 lines ending just above the already-rendered anchor — the anchor
 *     indices shift DOWN by 20 (`LeftIndex/RightIndex -= 20`) and the
 *     residual hunk sizes GROW by 20; the new expander row is PREPENDED and
 *     keeps the ORIGINAL last indices.
 *   - direction "down" AND remaining > 20 (partial, :83-86): the window is
 *     the 20 lines starting just below the last rendered row
 *     (`Last+1 .. Last+20`); afterwards last += 20; the residual hunk
 *     indices/sizes stay UNCHANGED; the expander row is APPENDED.
 *   - otherwise (full fill, :87-103): "up"/"single" expand
 *     `remaining - 1` lines — BOTH anchors are already rendered, so only the
 *     strictly-between lines are hidden (the ":88-94" comment's "so -1");
 *     "down" (or any unknown direction) expands `remaining` lines — the last
 *     rendered row exists, everything after it is rendered from the next
 *     line. Afterwards the hunk sizes and next indices are ZEROED so
 *     GetExpandDirection answers "" and no further expander is emitted
 *     (upstream does not insert one at all in this branch).
 *   - fillExcerptLines (:30-61) scans the blob FROM ITS FIRST LINE (the
 *     reader is the whole blob), buffering every scanned line up to
 *     `setting.UI.MaxDisplayFileSize` bytes (default 8388608,
 *     modules/setting/ui.go:98) into the highlight source — chroma needs the
 *     full file text to tokenize line N — while emitting rows only for
 *     [start, start+chunk). Buffering caps but scanning never aborts: rows
 *     past the cap still render, just unhighlighted.
 *   - Line splitting follows `NewGitDiffScanner` (modules/git/diff.go:144-150)
 *     = bufio.ScanLines: split on "\n", strip one trailing "\r" per line; a
 *     final line without a newline still counts.
 *
 * COMMENT-ANCHOR ROWS: `FillHiddenCommentIDsForDiffLine`
 * (gitdiff.go:267-292) stamps each expander row with the IDs of PR code
 * comments that sit inside its hidden range (strictly above LastRightIdx and
 * strictly below RightIdx — INCLUSIVE of RightIdx when RightHunkSize == 0,
 * the end-of-file expansion). Left-side comments (negative line numbers) are
 * skipped per upstream's BLOB-EXCERPT-COMMENT-RIGHT note (:275-277):
 * unchanged lines always use the right side.
 *
 * HashFilePathForWebUI (modules/git/utils.go:42-46) is the comment-anchor
 * hash: lowercase hex SHA-1 of the file path (upstream test vector
 * utils_test.go:14-17). Ours is async — WebCrypto is the Workers SHA-1.
 *
 * STAGE HANDOFF (wave-45 scope): this module is the MACHINERY stage of the
 * `/blob_excerpt/{sha}` skip (wave-39 cite, index.ts:4525 area). Stage 3 —
 * the `repo/diff/blob_excerpt` HTML fragment and its
 * `/{owner}/{repo}/(wiki/)blob_excerpt/{sha}` route — rides a LATER wave:
 * src/ui/index.ts is sibling-owned (repo-projects). That wave needs exactly
 * what is exported here: `buildBlobExcerptSection` for the row window,
 * `getExpandDirection` + `blobExcerptQuery` for the next expander button
 * (upstream RenderBlobExcerptButtons, gitdiff.go:232-265, which also builds
 * the `diff-<hash>K<rightIdx>` anchor — left to the HTML wave with
 * `hashFilePathForWebUI`), and `fillHiddenCommentIds` once code comments
 * land. Highlighting (chroma over `highlightSource`) is also stage 3; this
 * module only bounds and carries the source bytes, matching
 * fillExcerptLines' buf contract.
 *
 * Divergences (documented per AGENTS.md): (1) strings arrive as UTF-8 and
 * decode leniently (TextDecoder replacement), where Go carries raw bytes
 * through scanner.Text(); (2) blobExcerptQuery percent-encodes space as %20
 * (encodeURIComponent) where Go's url.QueryEscape emits "+" — both decode
 * identically server-side; (3) `highlightTruncated` is an ADDITION: upstream
 * leaves post-cap lines implicitly unhighlighted via the map miss.
 */

/** The engine's Hunk shape (dist-types/git/diff.d.ts) — structural, since `Hunk` is not on the engine's public type surface (mod.d.ts). */
interface EngineHunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
}/** Max lines of one excerpt expansion (upstream BlobExcerptChunkSize, gitdiff.go:134). */
export const BLOB_EXCERPT_CHUNK_SIZE = 20;

/** setting.UI.MaxDisplayFileSize default (modules/setting/ui.go:98) — the highlight-source byte cap. */
export const MAX_DISPLAY_FILE_SIZE = 8388608;

/**
 * Anchor options — the `blob_excerpt` form fields verbatim
 * (compare.go:708-716 FormInt/FormString names in the doc comment).
 */
export interface BlobExcerptOptions {
  /** 1-based last rendered line before the gap (0 = file start); form `last_left`. */
  lastLeft: number;
  /** form `last_right`. */
  lastRight: number;
  /** 1-based first rendered line after the gap; form `left`. */
  leftIndex: number;
  /** form `right`. */
  rightIndex: number;
  /** residual @@ hunk size on the left side; form `left_hunk_size`. */
  leftHunkSize: number;
  /** form `right_hunk_size`. */
  rightHunkSize: number;
  /** clicked button: "up" | "down" | "single" (anything else takes the "down" full-fill arm, upstream :87-99). */
  direction: string;
  /** file language hint for the stage-3 highlighter; form `filelang`. */
  language: string;
}

/**
 * The expander row's metadata — DiffLineSectionInfo (gitdiff.go:89-125). All
 * indices are 1-based INCLUSIVE line numbers; Last* = last rendered before
 * the hunk, Idx* = next rendered after it, *HunkSize = the hunk's line count
 * on that side.
 */
export interface BlobExcerptSectionInfo {
  path: string;
  lastLeftIdx: number;
  lastRightIdx: number;
  leftIdx: number;
  rightIdx: number;
  leftHunkSize: number;
  rightHunkSize: number;
  /** IDs of code comments hidden behind this expander (FillHiddenCommentIDsForDiffLine). */
  hiddenCommentIds?: number[];
}

/** The excerpt-relevant subset of DiffLine (gitdiff.go:75-86). */
export interface BlobExcerptLine {
  /** 1-based left line number (0 = none). */
  leftIdx: number;
  /** 1-based right line number. */
  rightIdx: number;
  /** "plain" (DiffLinePlain) for window rows, "section" (DiffLineSection) for the expander. */
  type: "plain" | "section";
  /** git-style marker-prefixed content: `" " + line` for plain rows (upstream :50); the expander carries the `@@ hunk @@` string. */
  content: string;
  sectionInfo?: BlobExcerptSectionInfo;
}

/**
 * The built section: the window rows (+ expander row), the byte-budgeted
 * file prefix for the stage-3 highlighter (fillExcerptLines' buf — lines 1
 * through the window end, each newline-terminated, \r-stripped), and whether
 * the cap cut that prefix short (our disclosure addition).
 */
export interface BlobExcerptSection {
  fileName: string;
  /** the `filelang` hint, carried for the stage-3 highlighter/button query (upstream DiffSection.language). */
  language: string;
  lines: BlobExcerptLine[];
  highlightSource: string;
  highlightTruncated: boolean;
}

const ENCODER = new TextEncoder();

/** Go len(string): UTF-8 byte length (ASCII fast path, TextEncoder fallback). */
function lineByteLength(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) > 0x7f) return ENCODER.encode(line).length;
  }
  return line.length;
}

/**
 * bufio.ScanLines split (modules/git/diff.go:144-150 via bufio.Scanner):
 * split on "\n" and strip one trailing "\r" per line; a trailing newline
 * does not yield an extra empty line, a final unterminated line still counts.
 */
export function scanLines(text: string): string[] {
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * fillExcerptLines (gitdiff_excerpt.go:30-61): scan the blob from line 1,
 * buffer every scanned line into the highlight source until
 * MAX_DISPLAY_FILE_SIZE bytes would be exceeded, and emit plain rows for
 * [rightStart, rightStart+chunkSize) with LeftIdx = leftStart + offset.
 * `text` is the decoded blob; returns rows + the highlight prefix + the cap flag.
 */
function fillExcerptLines(
  text: string,
  leftStart: number,
  rightStart: number,
  chunkSize: number,
): { lines: BlobExcerptLine[]; highlightSource: string; highlightTruncated: boolean } {
  const scanned = scanLines(text);
  const lines: BlobExcerptLine[] = [];
  let buffered = 0;
  let truncated = false;
  const source: string[] = [];
  for (let rightLineIdx = 1; rightLineIdx < rightStart + chunkSize; rightLineIdx++) {
    const lineText = scanned[rightLineIdx - 1];
    if (lineText === undefined) break; // scanner.Scan() false
    if (buffered + lineByteLength(lineText) < MAX_DISPLAY_FILE_SIZE) {
      source.push(lineText, "\n");
      buffered += lineByteLength(lineText) + 1;
    } else {
      truncated = true;
    }
    if (rightLineIdx < rightStart) continue;
    lines.push({
      leftIdx: leftStart + (rightLineIdx - rightStart),
      rightIdx: rightLineIdx,
      type: "plain",
      content: ` ${lineText}`, // upstream :50 — the " " diff marker prefixes Content
    });
  }
  return { lines, highlightSource: source.join(""), highlightTruncated: truncated };
}

/**
 * DiffLine.GetExpandDirection (gitdiff.go:205-217) — "" means no expander
 * buttons render for this row.
 */
export function getExpandDirection(info: BlobExcerptSectionInfo): "" | "up" | "down" | "updown" | "single" {
  if (info.leftIdx - info.lastLeftIdx <= 1 || info.rightIdx - info.lastRightIdx <= 1) return "";
  if (info.lastLeftIdx <= 0 && info.lastRightIdx <= 0) return "up";
  if (info.rightIdx - info.lastRightIdx - 1 > BLOB_EXCERPT_CHUNK_SIZE && info.rightHunkSize > 0) return "updown";
  if (info.leftHunkSize <= 0 && info.rightHunkSize <= 0) return "down";
  return "single";
}

/**
 * BuildBlobExcerptDiffSection (gitdiff_excerpt.go:63-132) over the decoded
 * blob text. Sync and pure: the stage-3 route reads the blob, decodes, and
 * calls this with the round-tripped form options.
 */
export function buildBlobExcerptSection(filePath: string, text: string, opts: BlobExcerptOptions): BlobExcerptSection {
  let lastLeft = opts.lastLeft;
  let lastRight = opts.lastRight;
  let idxLeft = opts.leftIndex;
  let idxRight = opts.rightIndex;
  let leftHunkSize = opts.leftHunkSize;
  let rightHunkSize = opts.rightHunkSize;
  const direction = opts.direction;

  const expandLimit = BLOB_EXCERPT_CHUNK_SIZE;
  const remainingLines = idxRight - lastRight;
  let filled: { lines: BlobExcerptLine[]; highlightSource: string; highlightTruncated: boolean };
  if (direction === "up" && remainingLines > expandLimit) {
    // :77-82 — window ends just above the rendered anchor; residual hunk grows upward
    idxLeft -= expandLimit;
    idxRight -= expandLimit;
    leftHunkSize += expandLimit;
    rightHunkSize += expandLimit;
    filled = fillExcerptLines(text, idxLeft, idxRight, expandLimit);
  } else if (direction === "down" && remainingLines > expandLimit) {
    // :83-86 — window starts just below the last rendered row; anchors advance
    filled = fillExcerptLines(text, lastLeft + 1, lastRight + 1, expandLimit);
    lastLeft += expandLimit;
    lastRight += expandLimit;
  } /* "single", unknown, or ("up"/"down" with remainingLines <= expandLimit) */ else {
    if (direction === "up" || direction === "single") {
      // :88-94 — both anchors are rendered; only the strictly-between lines are hidden
      filled = fillExcerptLines(text, lastLeft + 1, lastRight + 1, remainingLines - 1);
    } else {
      // :95-99 — "down" (or unknown) full fill renders everything after the last row
      filled = fillExcerptLines(text, lastLeft + 1, lastRight + 1, remainingLines);
    }
    // :101-103 — fully merged: zero the hunk so GetExpandDirection answers "" (no new buttons)
    leftHunkSize = 0;
    rightHunkSize = 0;
    idxLeft = 0;
    idxRight = 0;
  }

  const lines = filled.lines;
  const info: BlobExcerptSectionInfo = {
    path: filePath,
    lastLeftIdx: lastLeft,
    lastRightIdx: lastRight,
    leftIdx: idxLeft,
    rightIdx: idxRight,
    leftHunkSize,
    rightHunkSize,
  };
  const expander: BlobExcerptLine = { type: "section", leftIdx: 0, rightIdx: 0, content: "", sectionInfo: info };
  // :122-129 — the expander row ships only when it still has a direction, and
  // only "up"/"down" insert it (prepend/append respectively)
  if (getExpandDirection(info) !== "") {
    expander.content = `@@ -${idxLeft},${leftHunkSize} +${idxRight},${rightHunkSize} @@`;
    if (direction === "up") lines.unshift(expander);
    else if (direction === "down") lines.push(expander);
  }

  return {
    fileName: filePath,
    language: opts.language,
    lines,
    highlightSource: filled.highlightSource,
    highlightTruncated: filled.highlightTruncated,
  };
}

/**
 * FillHiddenCommentIDsForDiffLine (gitdiff.go:267-292) for one expander row.
 * `lineComments` maps RIGHT-side line numbers to their comments; negative
 * keys (left-side) are skipped per the BLOB-EXCERPT-COMMENT-RIGHT note
 * (:275-277 — unchanged lines always comment on the right side). The hidden
 * range is (lastRightIdx, rightIdx) EXCLUSIVE of rightIdx, except the
 * end-of-file expansion (rightHunkSize == 0) where rightIdx is INCLUDED
 * (:280-283). Mutates the row in place, upstream-style.
 */
export function fillHiddenCommentIds(line: BlobExcerptLine, lineComments: Map<number, Array<{ id: number }>>): void {
  if (line.type !== "section" || line.sectionInfo === undefined) return;
  const info = line.sectionInfo;
  const hiddenCommentIds: number[] = [];
  for (const [commentLineNum, comments] of lineComments) {
    if (commentLineNum < 0) continue; // left-side: BLOB-EXCERPT-COMMENT-RIGHT
    const isEndOfFileExpansion = info.rightHunkSize === 0;
    const inRange =
      commentLineNum > info.lastRightIdx &&
      (isEndOfFileExpansion ? commentLineNum <= info.rightIdx : commentLineNum < info.rightIdx);
    if (inRange) {
      for (const comment of comments) hiddenCommentIds.push(comment.id);
    }
  }
  info.hiddenCommentIds = hiddenCommentIds;
}

/**
 * DiffLine.getBlobExcerptQuery (gitdiff.go:189-203) — the form fields the
 * expander button round-trips to the (stage-3) fragment route. Space encodes
 * as %20 (encodeURIComponent) vs Go QueryEscape's "+" — server-equivalent.
 */
export function blobExcerptQuery(info: BlobExcerptSectionInfo, language = ""): string {
  return (
    `last_left=${info.lastLeftIdx}&last_right=${info.lastRightIdx}&` +
    `left=${info.leftIdx}&right=${info.rightIdx}&` +
    `left_hunk_size=${info.leftHunkSize}&right_hunk_size=${info.rightHunkSize}&` +
    `path=${encodeURIComponent(info.path)}&filelang=${encodeURIComponent(language)}`
  );
}

/**
 * HashFilePathForWebUI (modules/git/utils.go:42-46): lowercase hex SHA-1 of
 * the path — the comment-anchor hash (`diff-<hash>K<line>`, gitdiff.go:234)
 * and the template's FileNameHash (compare.go:790). Async: WebCrypto SHA-1.
 */
export async function hashFilePathForWebUI(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", ENCODER.encode(path));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Convenience bridge for the stage-3 button wave: the initial expander row of
 * a parsed hunk — DiffLineSection rows the upstream parser stamps per @@
 * header (gitdiff.go:1048-1065), where Last*Idx = hunk start - 1 (the "use
 * idx-1 as last idx" comment, :1053). Takes the engine's structured Hunk
 * (aStart/aLen/bStart/bLen) plus the running last indices a caller walking
 * several hunks tracks; callers that need mid-diff tracking walk the hunk ops
 * (del advances left, add advances right, context both) as upstream's
 * ParsePatch loop does.
 */
export function sectionInfoForHunkStart(path: string, hunk: EngineHunk, lastLeftIdx: number, lastRightIdx: number): BlobExcerptSectionInfo {
  return {
    path,
    lastLeftIdx,
    lastRightIdx,
    leftIdx: hunk.aStart,
    rightIdx: hunk.bStart,
    leftHunkSize: hunk.aLen,
    rightHunkSize: hunk.bLen,
  };
}
