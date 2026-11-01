/**
 * diffpatch service (SPEC-0004 §2.4 row repoApplyDiffPatch): apply a unified
 * diff to the repository as one commit — the Worker-side port of upstream
 * services/repository/files/patch.go ApplyDiffPatch
 * (`git apply --index --recount --cached --ignore-whitespace
 * --whitespace=fix --binary -3` on a temp clone, then commit + push).
 *
 * There is no git binary on Workers, so the apply is implemented directly:
 * a unified-diff parser (git-style `diff --git` sections, ---/+++ headers,
 * @@ hunks, new/deleted file markers, "\ No newline at end of file") and a
 * hunk applier over the engine's blob reads, producing the same FileChange[]
 * the contents-write family feeds into buildFileChangeCommit (putApiObjects
 * + ref CAS via services/contents.applyFileChanges — the single commit-build
 * seam of SPEC-0004 §3.4).
 *
 * Semantics and documented divergences:
 *   - context/deleted lines match with WHITESPACE INSIGNIFICANT comparison
 *     (--ignore-whitespace) at the hunk's expected position with an
 *     outward-drift search (git apply's offset tolerance); context bytes are
 *     preserved from the base file, added lines are taken verbatim minus a
 *     trailing CR (--whitespace=fix);
 *   - the `index <old>..<new>` line is parsed but NOT used for the -3
 *     three-way fallback (the base blob is whatever sits at the path);
 *   - binary patches ("GIT binary patch" / "Binary files … differ") are
 *     refused with the apply-failure 422 (upstream would apply binaries with
 *     --binary);
 *   - MODE CHANGES APPLY: `new file mode`, and `old mode`/`new mode` pairs,
 *     land through the commit builder's FileChange.mode — upstream
 *     `git apply --index` honors them (verified against the binary: a
 *     mode-only patch moves the entry's mode, `git apply --check --index`
 *     accepts exactly that headers-only section). Two divergences, both
 *     fail-closed where git is lenient (verified against the binary):
 *     a mismatched `old mode` pre-image only WARNS in git ("type is …,
 *     should be …", exit 0 even with --index) — refused here with the
 *     apply-failure 422 "does not match index"; a lone unpaired mode line
 *     or a mode no tree entry carries ("old mode banana") is git's
 *     corrupt-patch/invalid-mode error — mirrored as 422s;
 *   - an unapplicable patch is the 422 "patch does not apply" family —
 *     upstream's git-apply failure actually surfaces as a 500
 *     (handleChangeRepoFilesError has no apply-failure mapping); 422 is the
 *     declared-on-siblings validation code, documented in the route.
 *   - rename sections apply as delete(old) + create(new) through the change
 *     list (the commit builder's rename support is contents-PUT-shaped).
 */

import type { EngineReads } from "./engine";
import type { FileChange } from "./git-models";
import { ApiError } from "../errors";

/** One parsed file section of the patch. */
export interface PatchFile {
  oldPath: string | null; // null = /dev/null (new file)
  newPath: string | null; // null = /dev/null (deleted file)
  hunks: PatchHunk[];
  noOldNewline: boolean;
  noNewNewline: boolean;
  /**
   * The mode the file lands with: the new-mode half of an explicit
   * `old mode`/`new mode` pair, or the `new file mode` line of a creation.
   * Applied through FileChange.mode — upstream `git apply --index` honors
   * mode changes (git blob modes only).
   */
  targetMode?: string;
  /** The old-mode half of an explicit mode pair, validated against the base
   *  tree entry (git apply --index's "does not match index" gate). */
  sourceMode?: string;
}

/** The git blob modes a patch may set — trees and gitlinks never patch. */
const PATCH_MODES = new Set(["100644", "100755", "120000"]);

/** Parse a mode line's operand, refusing anything a tree entry cannot carry. */
function parsePatchMode(value: string): string | null {
  const mode = value.trim();
  return PATCH_MODES.has(mode) ? mode : null;
}

export interface PatchHunk {
  /** 1-based line numbers as declared (informational — application drifts) */
  oldStart: number;
  newStart: number;
  /** body ops: ' ' context, '-' removed, '+' added */
  ops: Array<{ tag: " " | "-" | "+"; line: string }>;
}

export const APPLY_FAILURE_MESSAGE = "patch does not apply";

function applyFailure(detail: string): ApiError {
  return new ApiError(422, `${APPLY_FAILURE_MESSAGE}: ${detail}`);
}

/** Split into lines WITHOUT terminators + whether the text ends with a newline. */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline: text.endsWith("\n") };
}

function stripPathPrefix(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return null;
  // git prefixes a/ b/; timestamps after a tab are stripped
  const path = trimmed.split("\t")[0] ?? trimmed;
  return path.replace(/^(a|b)\//, "").replace(/^\/+/, "");
}

function hunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/** A fresh, path-less section (the two newline markers default false). */
function emptySection(): PatchFile {
  return { oldPath: null, newPath: null, hunks: [], noOldNewline: false, noNewNewline: false };
}

/**
 * Parse a unified diff into file sections. Accepts the git-style form
 * (`diff --git …`, new/deleted file mode lines, old/new mode pairs,
 * ---/+++ headers) and the plain form (---/+++ only). Throws the
 * apply-failure 422 for binary sections (upstream --binary would apply them)
 * and for modes no tree entry can carry (upstream git apply refuses a
 * malformed mode the same way).
 */
export function parseUnifiedPatch(content: string): PatchFile[] {
  const lines = splitLines(content).lines;
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let activeHunk: PatchHunk | null = null;
  // `current` was opened by a `diff --git` line (the git-style form): its
  // ---/+++/hunks belong to the SAME section, and a bare `---` (the plain
  // form) must not flush it — the flush would drop the mode lines parsed
  // ahead of the ---/+++ pair
  let fromDiffGit = false;

  const flush = (): void => {
    // keep a section that carries anything applicable: hunks, paths (pure
    // rename / mode-only sections have NO ---/+++ to name them — the paths
    // come from the `diff --git a/x b/y` line), or mode lines
    if (
      current !== null &&
      (current.hunks.length > 0 || current.oldPath !== null || current.newPath !== null || current.sourceMode !== undefined || current.targetMode !== undefined)
    ) {
      files.push(current);
    }
    current = null;
    fromDiffGit = false;
    activeHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      flush();
      current = emptySection();
      fromDiffGit = true;
      // the paths ride this line too — a mode-only section has NO ---/+++
      // pair to name them (git prints none there). Unquoted `a/<old> b/<new>`
      // only (our renderer never quotes; a content section's ---/+++ pair
      // overrides these anyway).
      const body = line.slice("diff --git ".length);
      const sep = body.lastIndexOf(" b/");
      if (body.startsWith("a/") && sep > 2) {
        current.oldPath = body.slice(2, sep);
        current.newPath = body.slice(sep + 3);
      }
      continue;
    }
    if (line.startsWith("new file mode")) {
      if (current !== null) {
        current.oldPath = null;
        const mode = parsePatchMode(line.slice("new file mode".length));
        if (mode === null) throw applyFailure(`invalid new file mode: ${line}`);
        current.targetMode = mode;
      }
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      if (current !== null) {
        current.newPath = null;
        // the deleted file's mode is parsed only to refuse malformed modes —
        // the entry is gone after the apply either way
        if (parsePatchMode(line.slice("deleted file mode".length)) === null) {
          throw applyFailure(`invalid deleted file mode: ${line}`);
        }
      }
      continue;
    }
    if (line.startsWith("old mode ")) {
      if (current !== null) {
        const mode = parsePatchMode(line.slice("old mode ".length));
        if (mode === null) throw applyFailure(`invalid old mode: ${line}`);
        current.sourceMode = mode;
      }
      continue;
    }
    if (line.startsWith("new mode ")) {
      if (current !== null) {
        const mode = parsePatchMode(line.slice("new mode ".length));
        if (mode === null) throw applyFailure(`invalid new mode: ${line}`);
        current.targetMode = mode;
      }
      continue;
    }
    if (line.startsWith("rename from ")) {
      if (current !== null) current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      if (current !== null) current.newPath = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      throw applyFailure("binary patches are not supported");
    }
    if (line.startsWith("--- ")) {
      if (current !== null && !fromDiffGit) flush();
      if (current === null) {
        current = emptySection();
        fromDiffGit = false;
      }
      current.oldPath = stripPathPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const section: PatchFile = current ?? emptySection();
      section.newPath = stripPathPrefix(line.slice(4));
      current = section;
      continue;
    }
    const header = hunkHeader(line);
    if (header !== null) {
      if (current === null) {
        throw applyFailure(`hunk without a file header at line ${i + 1}`);
      }
      activeHunk = { oldStart: header.oldStart, newStart: header.newStart, ops: [] };
      current.hunks.push(activeHunk);
      continue;
    }
    if (activeHunk !== null) {
      if (line.startsWith("\\ No newline at end of file")) {
        // the marker speaks for the op right before it: "+" → the NEW file
        // lacks the trailing newline; "-" → the OLD one; " " → both.
        const last = activeHunk.ops[activeHunk.ops.length - 1];
        if (last !== undefined && current !== null) {
          if (last.tag === "+" || last.tag === " ") current.noNewNewline = true;
          if (last.tag === "-" || last.tag === " ") current.noOldNewline = true;
        }
        continue;
      }
      if (line === "") {
        // an empty trailing line of the patch body — git treats it as a
        // context line with the newline stripped by a mailer
        activeHunk.ops.push({ tag: " ", line: "" });
        continue;
      }
      const tag = line[0];
      if (tag === " " || tag === "-" || tag === "+") {
        activeHunk.ops.push({ tag, line: tag === " " || tag === "-" ? line.slice(1) : line.slice(1).replace(/\r$/, "") });
        continue;
      }
      // anything else ends the section's hunks (next file's headers handle
      // themselves via the ---/diff cases above)
      activeHunk = null;
    }
  }
  flush();
  return files;
}

/** Whitespace-insensitive comparison (--ignore-whitespace). */
function ignoreWhitespace(line: string): string {
  return line.replace(/[ \t\r]+/g, "");
}

/**
 * Apply one file's hunks to the base text. Returns the patched text (with
 * the base's trailing-newline state, adjusted by the no-newline markers).
 * Throws the apply-failure ApiError when a hunk's pre-image cannot be found.
 */
export function applyHunks(base: string, file: PatchFile): string {
  const { lines: baseLines } = splitLines(base);
  const out: string[] = [];
  let pos = 0; // next unconsumed base line

  for (const hunk of file.hunks) {
    const contextAndDeleted: string[] = [];
    for (const op of hunk.ops) {
      if (op.tag === " " || op.tag === "-") contextAndDeleted.push(op.line);
    }
    // locate the pre-image near the hunk's declared position (drift search)
    const expected = hunk.oldStart - 1;
    let at = -1;
    for (let drift = 0; at < 0; drift++) {
      if (expected - drift < pos && expected + drift > baseLines.length - contextAndDeleted.length) break;
      for (const candidate of drift === 0 ? [expected] : [expected - drift, expected + drift]) {
        if (candidate < pos || candidate + contextAndDeleted.length > baseLines.length) continue;
        let matched = true;
        for (let k = 0; k < contextAndDeleted.length; k++) {
          if (ignoreWhitespace(baseLines[candidate + k] ?? "") !== ignoreWhitespace(contextAndDeleted[k] ?? "")) {
            matched = false;
            break;
          }
        }
        if (matched) {
          at = candidate;
          break;
        }
      }
      if (drift > baseLines.length) break;
    }
    if (at < 0) {
      throw applyFailure(`hunk @-${hunk.oldStart} does not fit ${file.oldPath ?? file.newPath ?? "?"}`);
    }

    while (pos < at) {
      out.push(baseLines[pos] ?? "");
      pos += 1;
    }
    let cursor = at;
    for (const op of hunk.ops) {
      if (op.tag === " ") {
        out.push(baseLines[cursor] ?? ""); // preserve the base bytes verbatim
        cursor += 1;
        pos += 1;
      } else if (op.tag === "-") {
        cursor += 1;
        pos += 1;
      } else {
        out.push(op.line);
      }
    }
  }
  while (pos < baseLines.length) {
    out.push(baseLines[pos] ?? "");
    pos += 1;
  }
  // the no-newline marker is the only way a well-formed patch expresses a
  // missing final newline; every other result is newline-terminated
  if (out.length === 0) return "";
  return file.noNewNewline ? out.join("\n") : `${out.join("\n")}\n`;
}

/**
 * Parse + apply the whole patch against the base tree, producing the ordered
 * FileChange list for buildFileChangeCommit. Reads each touched file's blob
 * through `reads.readBlob(refTarget, path)`. An empty patch (no sections) is
 * the upstream git-apply no-op error → the apply-failure 422.
 */
export async function patchToFileChanges(reads: EngineReads, refTarget: string, content: string): Promise<FileChange[]> {
  const files = parseUnifiedPatch(content);
  if (files.length === 0) {
    throw applyFailure("no file sections found");
  }
  const changes: FileChange[] = [];
  for (const file of files) {
    const oldPath = file.oldPath;
    const newPath = file.newPath;
    const isRename = oldPath !== null && newPath !== null && oldPath !== newPath;

    if (oldPath === null && newPath === null) {
      throw applyFailure("section without a target path");
    }
    // a mode pair needs both halves (git apply refuses a lone mode line)
    if ((file.sourceMode === undefined) !== (file.targetMode === undefined) && file.oldPath !== null && file.newPath !== null) {
      throw applyFailure("mode change lines must pair old and new");
    }
    const baseBlob =
      oldPath === null
        ? null
        : await (async () => {
            const blob = await reads.readBlob(refTarget, oldPath);
            if (blob === null) throw applyFailure(`${oldPath} does not exist in the base tree`);
            return blob;
          })();
    // the pre-image mode gate: git apply only WARNS on a mismatched `old
    // mode` ("type is …, should be …", exit 0 even with --index — verified
    // against the binary); refused here instead — a patch claiming a
    // pre-image mode the base tree does not carry was not generated against
    // this tree, and silently moving the mode off that claim would mis-apply
    if (file.sourceMode !== undefined && baseBlob !== null && baseBlob.mode !== file.sourceMode) {
      throw applyFailure(`${oldPath}: does not match index (mode) [given: ${file.sourceMode}, expected: ${baseBlob.mode}]`);
    }
    const baseText = baseBlob === null ? "" : new TextDecoder().decode(baseBlob.data);

    // a hunk-less section (pure rename, mode-only move) carries the base
    // content through
    const patchedText = file.hunks.length === 0 ? baseText : applyHunks(baseText, file);
    if (newPath === null) {
      // deletion: the patched content must be empty (git apply --index)
      if (oldPath === null) throw applyFailure("section without a target path");
      if (patchedText !== "") {
        throw applyFailure(`deleted file ${oldPath} still has content after the patch`);
      }
      changes.push({ operation: "delete", path: oldPath });
      continue;
    }
    if (isRename) {
      changes.push({ operation: "delete", path: oldPath });
      changes.push({
        operation: "create",
        path: newPath,
        content: new TextEncoder().encode(patchedText),
        ...(file.targetMode === undefined ? {} : { mode: file.targetMode }),
      });
      continue;
    }
    if (oldPath === null) {
      changes.push({
        operation: "create",
        path: newPath,
        content: new TextEncoder().encode(patchedText),
        mode: file.targetMode ?? "100644",
      });
      continue;
    }
    changes.push({
      operation: "update",
      path: newPath,
      content: new TextEncoder().encode(patchedText),
      ...(file.targetMode === undefined ? {} : { mode: file.targetMode }),
    });
  }
  return changes;
}
