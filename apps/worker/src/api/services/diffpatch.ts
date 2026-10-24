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
 *   - binary patches ("GIT binary patch" / "Binary files … differ") and mode
 *     changes are refused with the apply-failure 422 (upstream would apply
 *     binaries with --binary);
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
 * (`diff --git …`, new/deleted file mode lines, ---/+++ headers) and the
 * plain form (---/+++ only). Throws the apply-failure 422 for binary
 * sections (upstream --binary would apply them).
 */
export function parseUnifiedPatch(content: string): PatchFile[] {
  const lines = splitLines(content).lines;
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let activeHunk: PatchHunk | null = null;

  const flush = (): void => {
    // a pure-rename section carries rename headers and NO hunks — keep it
    if (current !== null && (current.hunks.length > 0 || current.oldPath !== null || current.newPath !== null)) {
      files.push(current);
    }
    current = null;
    activeHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      flush();
      current = emptySection();
      continue;
    }
    if (line.startsWith("new file mode")) {
      if (current !== null) current.oldPath = null;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      if (current !== null) current.newPath = null;
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
      flush();
      const section: PatchFile = current ?? emptySection();
      section.oldPath = stripPathPrefix(line.slice(4));
      current = section;
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
    const baseText =
      oldPath === null
        ? ""
        : await (async () => {
            const blob = await reads.readBlob(refTarget, oldPath);
            if (blob === null) throw applyFailure(`${oldPath} does not exist in the base tree`);
            return new TextDecoder().decode(blob.data);
          })();

    // a hunk-less section (pure rename) carries the base content through
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
      changes.push({ operation: "create", path: newPath, content: new TextEncoder().encode(patchedText) });
      continue;
    }
    if (oldPath === null) {
      changes.push({ operation: "create", path: newPath, content: new TextEncoder().encode(patchedText) });
      continue;
    }
    changes.push({ operation: "update", path: newPath, content: new TextEncoder().encode(patchedText) });
  }
  return changes;
}
