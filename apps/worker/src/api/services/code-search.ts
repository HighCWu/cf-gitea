import type { TreeEntryJson } from "@cf-gitea/git-engine";

import { ApiError } from "../errors";
import type { EngineReads } from "./engine";

/**
 * The repo-scoped code-search derivation (upstream 38389f00be at pin
 * 099abf5db4) — the git-grep engine's semantics ported over plain tree/blob
 * engine reads, because this upstream route needs NO code indexer: it reads
 * the git data live (`GET /repos/{o}/{r}/code/search`, api.go:1331, whose
 * commit message says exactly that). The ported pieces:
 *
 *   - `parseCodeSearchQuery` — modules/indexer/query.go ParseSearchQuery, the
 *     unified grammar both routes share (whitespace terms, "phrases",
 *     /regexp/ terms, path:/language:/repo:/user:/org: qualifiers and their
 *     exact 422 messages).
 *   - the file matcher — modules/indexer/code/internal/util.go FileMatcher
 *     (EVERY term must match the path OR the content, case-insensitively).
 *   - IsSearchable — size ≤ MaxIndexerFileSize (1 MB, the upstream default)
 *     and not vendored (the go-enry v2.9.6 VendorMatchers list — fetched
 *     verbatim from go-enry's data/vendor.go, linguist commit 537297c) minus
 *     the .gitignore/.gitattributes/.gitmodules basename override
 *     (modules/analyze/vendor.go). IncludePatterns/ExcludePatterns have no
 *     config surface here: upstream's defaults are empty, so those arms are
 *     structurally present and always pass.
 *   - BuildResultFragments — modules/indexer/code/search.go (max 10
 *     fragments, 4 KiB clip, block merge, rune-boundary truncation).
 *   - the search pipeline — modules/indexer/code/gitgrep/gitgrep.go
 *     PerformSearch: full-tree walk in `git ls-tree -r` order (depth-first in
 *     stored tree order), matcher per eligible file, the 50-file result cap
 *     with `incomplete`, page/pageSize slice (default size 50).
 *
 * Offset model: upstream computes every match index in UTF-8 BYTES (Go
 * strings); this port computes matches and fragment bounds in JS string
 * offsets and converts to UTF-8 byte offsets ONCE at the wire boundary
 * (`toWireIndices` — the swagger's "UTF-8 byte offsets in the fragment").
 * The match/no-match decision, the matched text, the fragment text and the
 * result order are unaffected; only the numeric index encoding passes
 * through the conversion. Recorded divergences (honest, each
 * upstream-motivated):
 *
 *   1. NO git binary: upstream prefilters candidate files with
 *      `git grep -l -z -I --perl-regexp --ignore-case --full-name
 *      --all-match` and unions that with single-term path matches before
 *      running the authoritative matcher; the matcher is the arbiter on both
 *      sides, so reading every IsSearchable file yields the SAME result set
 *      at a higher read cost (the prefilter's only job is cost). Workers
 *      subrequest limits make the cost real, so the scan carries explicit
 *      budgets (MAX_SCANNED_FILES / MAX_TREE_DIRS) that flag `incomplete` —
 *      the budget-exit-never-null rule the engine's own grep RPC follows.
 *      Upstream's analog is the 30-second grep deadline (also `incomplete`).
 *   2. Case folding is JavaScript's per-code-point `toLowerCase` rather than
 *      Go's per-rune `unicode.ToLower` — identical on ordinary text; exotic
 *      single-rune folds (Turkish İ lowers to two code units here) can shift
 *      a mapped match START to a different rune boundary than Go's
 *      stale-boundary walk emits. Match/no-match and fragment text are
 *      unaffected; only exotic offset mappings can differ.
 *   3. Regexp terms compile as JavaScript RegExp with the `i` flag where
 *      upstream compiles RE2 with `(?i)`; RE2-only syntax (inline flag
 *      groups like `(?-i)`) that JavaScript rejects falls back to
 *      case-SENSITIVE matching instead of erroring (parse time already
 *      validated the pattern upstream-side, so this arm is unreachable
 *      upstream).
 *   4. The non-text sniff is the NUL-in-first-8192-bytes probe
 *      (ui/page-data.isBinaryData — the landed blame idiom) standing in for
 *      Go's typesniffer; a non-text file keeps its PATH eligibility with
 *      empty content on both sides (ReadFile's nil-content posture).
 *   5. `charset.ToUTF8DropErrors` is TextDecoder's default lossy decode
 *      (invalid UTF-8 → U+FFFD) — the same observable contract.
 */

/** Upstream `gitgrep.MaxResultLimit` (modules/indexer/code/gitgrep/gitgrep.go:22). */
export const GIT_GREP_MAX_RESULT_LIMIT = 50;
/** Upstream `codeSearchResultWindow` (routers/api/v1/repo/code_search.go:22). */
export const CODE_SEARCH_RESULT_WINDOW = 1000;
/** Upstream `MaxResultFragments` / `MaxResultFragmentSize` (indexer/code/search.go:21-22). */
export const MAX_RESULT_FRAGMENTS = 10;
export const MAX_RESULT_FRAGMENT_SIZE = 4 * 1024;
/** Upstream `setting.Indexer.MaxIndexerFileSize` default (setting/indexer.go:49). */
export const MAX_INDEXER_FILE_SIZE = 1024 * 1024;

/**
 * The route-side scan budgets (divergence 1): a full DFS walk costs one RPC
 * per directory plus one per content-read file. The caps keep the worst case
 * inside a paid deployment's 1000-subrequest envelope (the same math
 * ui/pages/code-search-federation.ts documents for its fan-out cap), each
 * exit flagging `incomplete` like upstream's deadline does. Constants, not
 * vars — a heavier deployment raises them in one place.
 */
export const MAX_SCANNED_FILES = 300;
export const MAX_TREE_DIRS = 200;

// ---------------------------------------------------------------------------
// The query parser — modules/indexer/query.go ParseSearchQuery, verbatim
// grammar with upstream's exact 422 messages.
// ---------------------------------------------------------------------------

export type SearchTermKind = "literal" | "regexp";

export interface SearchTerm {
  kind: SearchTermKind;
  /** literal: the raw term text (quotes stripped); regexp: the decoded pattern */
  text: string;
}

export interface SearchQuery {
  terms: SearchTerm[];
  /** the `path:` qualifier value (path.Clean'd) */
  path: string;
  /** the resolved `language:` qualifier (enry alias lookup upstream) */
  language: string;
  /** `repo:OWNER/NAME` values */
  repos: string[];
  /** `user:`/`org:` values */
  owners: string[];
}

function queryError(message: string): ApiError {
  // indexer.SearchQueryError → codeSearchError's 422 arm
  // (routers/api/v1/repo/code_search.go:24-27).
  return new ApiError(422, message);
}

const QUALIFIER_NAMES = new Set(["path", "language", "repo", "user", "org"]);
const UNSUPPORTED_QUALIFIER_NAMES = new Set(["content", "symbol", "is", "in", "filename", "extension"]);

/** Go's `path.Clean` for the qualifier value (Clean("a//b/../c") = "a/c",
 *  Clean("") = "."; the parser rejects a leading "/" before this runs). */
function goPathClean(p: string): string {
  if (p === "") return ".";
  const absolute = p.startsWith("/");
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      else if (!absolute) stack.push("..");
    } else {
      stack.push(part);
    }
  }
  let cleaned = stack.join("/");
  if (absolute) cleaned = "/" + cleaned;
  if (cleaned === "") cleaned = absolute ? "/" : ".";
  return cleaned;
}

export function parseCodeSearchQuery(q: string): SearchQuery {
  const query: SearchQuery = { terms: [], path: "", language: "", repos: [], owners: [] };
  const tokens: string[] = [];
  let remaining = trimLeftSpace(q);
  while (remaining !== "") {
    const end = indexSpace(remaining);
    const limit = end < 0 ? remaining.length : end;
    const token = remaining.slice(0, limit);
    const colonAt = token.indexOf(":");
    const hasColon = colonAt >= 0;
    const name = colonAt >= 0 ? token.slice(0, colonAt) : token;
    let qualifier = false;
    if (hasColon) {
      const bare = name.startsWith("-") ? name.slice(1) : name;
      if (QUALIFIER_NAMES.has(bare)) {
        if (name.startsWith("-")) {
          throw queryError("Negated qualifiers are not supported");
        }
        qualifier = true;
      } else if (UNSUPPORTED_QUALIFIER_NAMES.has(bare)) {
        throw queryError("Unsupported qualifier");
      }
    }
    const start = qualifier ? name.length + 1 : 0;
    let text = remaining.slice(start, limit);
    const quoted = text.startsWith('"');
    let consumed = limit;
    if (quoted) {
      const parsed = parseSearchPhrase(remaining, start);
      text = parsed.text;
      consumed = parsed.end;
    }
    remaining = remaining.slice(consumed);
    if (text.includes("\n") || text.includes("\x00")) {
      throw queryError("Terms must not contain LF or NUL");
    }
    if (qualifier) {
      if (text === "") {
        throw queryError("Empty qualifier value");
      }
      switch (name) {
        case "path": {
          if (query.path !== "") {
            throw queryError("Repeated path qualifier");
          }
          if (text.startsWith("/") || text.split("/").includes("..") || (!quoted && /[*?[]/.test(text))) {
            throw queryError("Invalid path qualifier");
          }
          query.path = goPathClean(text);
          if (query.path === ".") {
            throw queryError("Invalid path qualifier");
          }
          break;
        }
        case "language": {
          // The indexer arm's qualifier; the git-grep arm rejects it at
          // codesearch.go:63-64 BEFORE any engine runs. The alias table is
          // upstream's enry map — no config surface here, so the parse keeps
          // the value verbatim and the ENGINES own the verdict (the git-grep
          // arm's "not supported" 422 fires either way; only the indexer
          // arm's "Unknown language" message could differ, and that arm
          // never serves on this instance).
          if (query.language !== "") {
            throw queryError("Repeated language qualifier");
          }
          query.language = text;
          break;
        }
        case "repo": {
          const parts = text.split("/");
          if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
            throw queryError("Repository must be OWNER/NAME");
          }
          query.repos.push(text);
          break;
        }
        case "user":
        case "org": {
          query.owners.push(text);
          break;
        }
      }
    } else {
      const term: SearchTerm = { kind: "literal", text };
      if (!quoted) {
        if (text === "AND" || text === "OR" || text === "NOT") {
          throw queryError("Boolean operators are not supported");
        }
        if (text.startsWith("/") && text.endsWith("/") && text.length >= 2 && isEvenTrailingBackslashRun(text)) {
          term.kind = "regexp";
          term.text = parseSearchRegexp(text.slice(1, text.length - 1));
        }
      }
      // Go counts BYTES here (len(term.Text) > 256).
      if (utf8ByteLength(term.text) > 256) {
        throw queryError("Term exceeds 256 bytes");
      }
      query.terms.push(term);
      if (query.terms.length > 16) {
        throw queryError("Query exceeds 16 terms");
      }
    }
    if (!qualifier || name !== "language") {
      tokens.push(token);
    }
    remaining = trimLeftSpace(remaining);
  }
  if (query.terms.length === 0) {
    throw queryError("Query must contain a search term");
  }
  return query;
}

/** `strings.TrimLeftFunc(q, unicode.IsSpace)` over Go's IsSpace set. */
function trimLeftSpace(s: string): string {
  let i = 0;
  while (i < s.length && isGoSpace(s.charCodeAt(i))) i++;
  return s.slice(i);
}

/** The next Go-IsSpace index, or -1. */
function indexSpace(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (isGoSpace(s.charCodeAt(i))) return i;
  }
  return -1;
}

/** Go unicode.IsSpace ('\t','\n','\v','\f','\r',' ',U+0085,U+00A0 — the
 *  BMP set; astral spaces only matter for the after-quote check below). */
function isGoSpace(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0
  );
}

/** `parseSearchPhrase(remaining, start)` — modules/indexer/query.go:161-182:
 *  escapes \" and \\, the empty phrase and post-quote text are errors, an
 *  unterminated phrase is an error. Returns the text and the consumed end
 *  (the index AFTER the closing quote). */
function parseSearchPhrase(token: string, start: number): { text: string; end: number } {
  let phrase = "";
  for (let i = start + 1; i < token.length; i++) {
    const ch = token[i];
    if (ch === '"') {
      if (phrase.length === 0) {
        throw queryError("Empty quoted value");
      }
      if (i + 1 < token.length && !isGoSpaceAt(token, i + 1)) {
        throw queryError("Unexpected text after closing quote");
      }
      return { text: phrase, end: i + 1 };
    }
    if (ch === "\\" && i + 1 < token.length && (token[i + 1] === '"' || token[i + 1] === "\\")) {
      i++;
      phrase += token[i];
      continue;
    }
    phrase += ch;
  }
  throw queryError("Unterminated quote");
}

/** `unicode.IsSpace` of the rune at `index` (Go decodes the full rune; the
 *  astral White_Space members are enumerated here). */
function isGoSpaceAt(s: string, index: number): boolean {
  const cp = s.codePointAt(index) ?? 0;
  if (cp < 0x10000) return isGoSpace(cp);
  return (
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** The trailing backslash run of `/…\/` (query.go:127-139): a pattern ending
 *  in an EVEN backslash run closes a regexp term; an odd run escapes the
 *  slash and the token stays a literal. */
function isEvenTrailingBackslashRun(text: string): boolean {
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

/** `parseSearchRegexp` — query.go:184-202: 1..256 bytes, `\/` decodes to
 *  `/`, every other `\x` stays `\x`; the pattern must compile (upstream
 *  compiles RE2, message "Invalid regexp"). */
function parseSearchRegexp(pattern: string): string {
  if (pattern === "" || utf8ByteLength(pattern) > 256) {
    throw queryError("Regexp must contain 1 to 256 bytes");
  }
  let decoded = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      i++;
      if (pattern[i] !== "/") {
        decoded += "\\";
      }
      decoded += pattern[i];
      continue;
    }
    decoded += pattern[i];
  }
  try {
    new RegExp(decoded);
  } catch {
    throw queryError("Invalid regexp");
  }
  return decoded;
}

/** UTF-8 byte length of a JS string (Go `len(string)`). */
export function utf8ByteLength(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      len += 4;
      i++;
    } else if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else len += 3;
  }
  return len;
}

/** UTF-16 code-unit offsets → UTF-8 byte offsets inside the SAME string. */
export function utf16ToBytes(text: string, units: number): number {
  let bytes = 0;
  let i = 0;
  while (i < units && i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 2;
      continue;
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    i += 1;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// The file matcher — modules/indexer/code/internal/util.go FileMatcher.
// All ranges this matcher emits are JS STRING offsets into `content`
// (converted to wire bytes at the fragment boundary — see the offset model).
// ---------------------------------------------------------------------------

export interface MatchRange {
  start: number;
  end: number;
}

interface FileMatcherTerm {
  /** the lowercased term text (Go lowers at NewFileMatcher, util.go:62) */
  text: string;
  pattern: RegExp | null;
}

export class FileMatcher {
  readonly terms: FileMatcherTerm[];

  constructor(terms: SearchTerm[]) {
    this.terms = terms.map((term) => {
      if (term.kind === "regexp") {
        let pattern: RegExp;
        try {
          pattern = new RegExp(term.text, "gi");
        } catch {
          // Divergence 3: RE2-only syntax — fall back to case-sensitive
          // instead of erroring (upstream's RE2 compile of a parse-validated
          // pattern cannot fail here).
          pattern = new RegExp(term.text, "g");
        }
        return { text: term.text.toLowerCase(), pattern };
      }
      return { text: term.text.toLowerCase(), pattern: null };
    });
  }

  /** `MatchFile(path, content)` — every term must match path OR content.
   *  Returns the merged ranges into `content`, or null when unmatched. */
  matchFile(path: string, content: string): MatchRange[] | null {
    if (this.terms.length === 0) return [];
    const ranges: MatchRange[] = [];
    // Go: norm.NFC.String(strings.ToLower(path)) vs norm.NFC.String(term.text).
    const lowerPath = path.toLowerCase().normalize("NFC");
    // Per-code-point tables for the lower→original offset walk.
    const orig16Start: number[] = [];
    const lower16Start: number[] = [];
    const lowerForms: string[] = [];
    let orig16 = 0;
    let low16 = 0;
    let lowerStr = "";
    for (const ch of content) {
      orig16Start.push(orig16);
      orig16 += ch.length;
      const form = ch.toLowerCase();
      lowerForms.push(form);
      lower16Start.push(low16);
      low16 += form.length;
      lowerStr += form;
    }
    let ok = true;
    for (const term of this.terms) {
      let found = false;
      if (term.pattern !== null) {
        // Per-line findAll, max 1000 across the file (util.go:89-105); a
        // non-empty match appends its range, EVERY match sets `found`
        // (including zero-width ones, like Go's FindAllStringIndex).
        let count = 0;
        for (const line of lineBoundaries(content)) {
          if (count >= 1000) break;
          const re = term.pattern;
          re.lastIndex = 0;
          let m = re.exec(line.text);
          while (m !== null && count < 1000) {
            found = true;
            count++;
            if (m[0].length > 0) {
              ranges.push({ start: line.start + m.index, end: line.start + m.index + m[0].length });
            }
            if (m[0].length === 0) re.lastIndex++;
            m = re.exec(line.text);
          }
          if (count >= 1000) break;
        }
        if (!found && term.pattern.test(lowerPath)) {
          found = true;
        }
        term.pattern.lastIndex = 0;
      } else if (term.text !== "") {
        // Literal: all occurrences (max 1000) in the lowered string
        // (util.go:106-120), then the walk maps them back through the
        // per-rune lower lengths (util.go:126-141 — including Go's
        // stale-boundary quirk when a match begins inside a multi-unit
        // lowered form: the walk only rewrites originalStart on an EXACT
        // boundary equality, so such a start keeps the previous boundary).
        let from = 0;
        const lowerRanges: Array<{ start: number; end: number }> = [];
        let count = 0;
        while (count < 1000) {
          const position = lowerStr.indexOf(term.text, from);
          if (position < 0) break;
          found = true;
          count++;
          lowerRanges.push({ start: position, end: position + term.text.length });
          from = position + term.text.length;
        }
        if (!found && lowerPath.includes(term.text.normalize("NFC"))) {
          found = true;
        }
        // The lower→original walk (util.go:126-141) in string units.
        let idx = 0;
        let originalStart = 0;
        let lowerOffset = 0;
        let runeIdx = 0;
        while (runeIdx <= lowerForms.length && idx < lowerRanges.length) {
          const range = lowerRanges[idx];
          if (range === undefined) break;
          if (lowerOffset === range.start) {
            originalStart = orig16Start[runeIdx] ?? orig16;
          }
          if (lowerOffset === range.end) {
            ranges.push({ start: originalStart, end: orig16Start[runeIdx] ?? orig16 });
            idx++;
            continue;
          }
          if (runeIdx === lowerForms.length) break;
          lowerOffset += (lowerForms[runeIdx] ?? "").length;
          runeIdx++;
        }
      } else {
        // Empty term: Go falls through Contains(path, "") — always true.
        found = true;
      }
      if (!found) {
        ok = false;
        break;
      }
    }
    if (!ok) return null;
    return mergeRanges(ranges);
  }
}

/** Go `strings.Lines` — the line boundaries (text WITHOUT its newline, the
 *  line's string start). The phantom trailing empty element of split("\n")
 *  is dropped; empty content yields no lines (Go yields none). */
function lineBoundaries(content: string): Array<{ text: string; start: number }> {
  const lines: Array<{ text: string; start: number }> = [];
  if (content === "") return lines;
  let start = 0;
  for (;;) {
    const nl = content.indexOf("\n", start);
    if (nl < 0) {
      lines.push({ text: content.slice(start), start });
      break;
    }
    lines.push({ text: content.slice(start, nl), start });
    start = nl + 1;
  }
  return lines;
}

/** `MergeMatchRanges` (util.go:41-52): sort by start, merge overlaps. */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: MatchRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
      continue;
    }
    merged.push({ ...r });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// IsSearchable — modules/indexer/code/internal/util.go:144-160 with the
// upstream default settings (MaxIndexerFileSize 1 MB, ExcludeVendored true,
// Include/Exclude patterns empty).
// ---------------------------------------------------------------------------

/** The go-enry v2.9.6 VendorMatchers (data/vendor.go, linguist 537297c) —
 *  IsVendor's first gate (modules/analyze/vendor.go:16-19). */
const VENDOR_MATCHERS: RegExp[] = [
  /(^|\/)cache\//,
  /^[Dd]ependencies\//,
  /(^|\/)dist\//,
  /^deps\//,
  /(^|\/)configure$/,
  /(^|\/)config\.guess$/,
  /(^|\/)config\.sub$/,
  /(^|\/)aclocal\.m4/,
  /(^|\/)libtool\.m4/,
  /(^|\/)ltoptions\.m4/,
  /(^|\/)ltsugar\.m4/,
  /(^|\/)ltversion\.m4/,
  /(^|\/)lt~obsolete\.m4/,
  /(^|\/)dotnet-install\.(ps1|sh)$/,
  /(^|\/)cpplint\.py/,
  /(^|\/)node_modules\//,
  /(^|\/)\.yarn\/releases\//,
  /(^|\/)\.yarn\/plugins\//,
  /(^|\/)\.yarn\/sdks\//,
  /(^|\/)\.yarn\/versions\//,
  /(^|\/)\.yarn\/unplugged\//,
  /(^|\/)_esy$/,
  /(^|\/)bower_components\//,
  /^rebar$/,
  /(^|\/)erlang\.mk/,
  /(^|\/)Godeps\/_workspace\//,
  /(^|\/)testdata\//,
  /(^|\/)\.indent\.pro/,
  /(\.|-)min\.(js|css)$/,
  /([^\s]*)import\.(css|less|scss|styl)$/,
  /(^|\/)bootstrap([^/.]*)(\..*)?\.(js|css|less|scss|styl)$/,
  /(^|\/)custom\.bootstrap([^\s]*)(js|css|less|scss|styl)$/,
  /(^|\/)font-?awesome\.(css|less|scss|styl)$/,
  /(^|\/)font-?awesome\/.*\.(css|less|scss|styl)$/,
  /(^|\/)foundation\.(css|less|scss)$/,
  /(^|\/)normalize\.(css|less|scss|styl)$/,
  /(^|\/)skeleton\.(css|less|scss)$/,
  /(^|\/)[Bb]ourbon\/.*\.(css|less|scss|styl)$/,
  /(^|\/)animate\.(css|less|scss)$/,
  /(^|\/)materialize\.(css|less|scss|styl|js)$/,
  /(^|\/)select2\/.*\.(css|scss|js)$/,
  /(^|\/)bulma\.(css|sass|scss)$/,
  /(3rd|[Tt]hird)[-_]?[Pp]arty\//,
  /(^|\/)vendors?\//,
  /(^|\/)[Ee]xtern(als?)?\//,
  /(^|\/)[Vv]+endor\//,
  /^debian\//,
  /(^|\/)run\.n$/,
  /(^|\/)bootstrap-datepicker\//,
  /(^|\/)jquery([^.]*)\.js$/,
  /(^|\/)jquery-\d\.\d+(\.\d+)?\.js$/,
  /(^|\/)jquery-ui(-\d\.\d+(\.\d+)?)?(\.\w+)?\.(js|css)$/,
  /(^|\/)jquery\.(ui|effects)\.([^.]*)\.(js|css)$/,
  /(^|\/)jquery\.fn\.gantt\.js/,
  /(^|\/)jquery\.fancybox\.(js|css)/,
  /(^|\/)fuelux\.js/,
  /(^|\/)jquery\.fileupload(-\w+)?\.js$/,
  /(^|\/)jquery\.dataTables\.js/,
  /(^|\/)bootbox\.js/,
  /(^|\/)pdf\.worker\.js/,
  /(^|\/)slick\.\w+.js$/,
  /(^|\/)Leaflet\.Coordinates-\d+\.\d+\.\d+\.src\.js$/,
  /(^|\/)leaflet\.draw-src\.js/,
  /(^|\/)leaflet\.draw\.css/,
  /(^|\/)Control\.FullScreen\.css/,
  /(^|\/)Control\.FullScreen\.js/,
  /(^|\/)leaflet\.spin\.js/,
  /(^|\/)wicket-leaflet\.js/,
  /(^|\/)\.sublime-project/,
  /(^|\/)\.sublime-workspace/,
  /(^|\/)\.vscode\//,
  /(^|\/)prototype(.*)\.js$/,
  /(^|\/)effects\.js$/,
  /(^|\/)controls\.js$/,
  /(^|\/)dragdrop\.js$/,
  /(.*?)\.d\.ts$/,
  /(^|\/)mootools([^.]*)\d+\.\d+.\d+([^.]*)\.js$/,
  /(^|\/)dojo\.js$/,
  /(^|\/)MochiKit\.js$/,
  /(^|\/)yahoo-([^.]*)\.js$/,
  /(^|\/)yui([^.]*)\.js$/,
  /(^|\/)ckeditor\.js$/,
  /(^|\/)tiny_mce([^.]*)\.js$/,
  /(^|\/)tiny_mce\/(langs|plugins|themes|utils)/,
  /(^|\/)ace-builds\//,
  /(^|\/)fontello(.*?)\.css$/,
  /(^|\/)MathJax\//,
  /(^|\/)Chart\.js$/,
  /(^|\/)[Cc]ode[Mm]irror\/(\d+\.\d+\/)?(lib|mode|theme|addon|keymap|demo)/,
  /(^|\/)shBrush([^.]*)\.js$/,
  /(^|\/)shCore\.js$/,
  /(^|\/)shLegacy\.js$/,
  /(^|\/)angular([^.]*)\.js$/,
  /(^|\/)d3(\.v\d+)?([^.]*)\.js$/,
  /(^|\/)react(-[^.]*)?\.js$/,
  /(^|\/)flow-typed\/.*\.js$/,
  /(^|\/)modernizr-\d\.\d+(\.\d+)?\.js$/,
  /(^|\/)modernizr\.custom\.\d+\.js$/,
  /(^|\/)knockout-(\d+\.){3}(debug\.)?js$/,
  /(^|\/)docs?\/_?(build|themes?|templates?|static)\//,
  /(^|\/)admin_media\//,
  /(^|\/)env\//,
  /(^|\/)fabfile\.py$/,
  /(^|\/)waf$/,
  /(^|\/)\.osx$/,
  /\.xctemplate\//,
  /\.imageset\//,
  /(^|\/)Carthage\//,
  /(^|\/)Sparkle\//,
  /(^|\/)Crashlytics\.framework\//,
  /(^|\/)Fabric\.framework\//,
  /(^|\/)BuddyBuildSDK\.framework\//,
  /(^|\/)Realm\.framework/,
  /(^|\/)RealmSwift\.framework/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.gitmodules$/,
  /(^|\/)gradlew$/,
  /(^|\/)gradlew\.bat$/,
  /(^|\/)gradle\/wrapper\//,
  /(^|\/)mvnw$/,
  /(^|\/)mvnw\.cmd$/,
  /(^|\/)\.mvn\/wrapper\//,
  /-vsdoc\.js$/,
  /\.intellisense\.js$/,
  /(^|\/)jquery([^.]*)\.validate(\.unobtrusive)?\.js$/,
  /(^|\/)jquery([^.]*)\.unobtrusive-ajax\.js$/,
  /(^|\/)[Mm]icrosoft([Mm]vc)?([Aa]jax|[Vv]alidation)(\.debug)?\.js$/,
  /(^|\/)[Pp]ackages\/.+\.\d+\//,
  /(^|\/)extjs\/.*?\.js$/,
  /(^|\/)extjs\/.*?\.xml$/,
  /(^|\/)extjs\/.*?\.txt$/,
  /(^|\/)extjs\/.*?\.html$/,
  /(^|\/)extjs\/.*?\.properties$/,
  /(^|\/)extjs\/\.sencha\//,
  /(^|\/)extjs\/docs\//,
  /(^|\/)extjs\/builds\//,
  /(^|\/)extjs\/cmd\//,
  /(^|\/)extjs\/examples\//,
  /(^|\/)extjs\/locale\//,
  /(^|\/)extjs\/packages\//,
  /(^|\/)extjs\/plugins\//,
  /(^|\/)extjs\/resources\//,
  /(^|\/)extjs\/src\//,
  /(^|\/)extjs\/welcome\//,
  /(^|\/)html5shiv\.js$/,
  /(^|\/)[Tt]ests?\/fixtures\//,
  /(^|\/)[Ss]pecs?\/fixtures\//,
  /(^|\/)cordova([^.]*)\.js$/,
  /(^|\/)cordova-\d\.\d(\.\d)?\.js$/,
  /(^|\/)foundation(\..*)?\.js$/,
  /(^|\/)Vagrantfile$/,
  /(^|\/)\.[Dd][Ss]_[Ss]tore$/,
  /(^|\/)inst\/extdata\//,
  /(^|\/)octicons\.css/,
  /(^|\/)sprockets-octicons\.scss/,
  /(^|\/)activator$/,
  /(^|\/)activator\.bat$/,
  /(^|\/)proguard\.pro$/,
  /(^|\/)proguard-rules\.pro$/,
  /(^|\/)puphpet\//,
  /(^|\/)\.google_apis\//,
  /(^|\/)Jenkinsfile$/,
  /(^|\/)\.gitpod\.Dockerfile$/,
  /(^|\/)\.github\//,
  /(^|\/)\.obsidian\//,
  /(^|\/)\.teamcity\//,
  /(^|\/)xvba_modules\//,
];

const NEVER_VENDOR_BASENAMES = new Set([".gitignore", ".gitattributes", ".gitmodules"]);

/** `analyze.IsVendor` — the enry gate plus the single-file basename override. */
export function isVendorPath(treePath: string): boolean {
  const basename = treePath.slice(treePath.lastIndexOf("/") + 1);
  if (NEVER_VENDOR_BASENAMES.has(basename)) return false;
  return VENDOR_MATCHERS.some((re) => re.test(treePath));
}

/** `internal.IsSearchable` with the upstream default settings — the size
 *  gate and the vendored gate; the include/exclude pattern arms are
 *  structurally present with empty always-pass lists (no config surface). */
export function isSearchable(path: string, size: number): boolean {
  if (size > MAX_INDEXER_FILE_SIZE) return false;
  if (isVendorPath(path)) return false;
  return true;
}

/** The non-text sniff (divergence 4): NUL in the first 8 KiB — the landed
 *  isBinaryData idiom standing in for Go's typesniffer. */
function isBinaryContent(data: Uint8Array): boolean {
  const probe = data.subarray(0, 8192);
  return probe.includes(0);
}

// ---------------------------------------------------------------------------
// BuildResultFragments — modules/indexer/code/search.go:113-166, computed in
// string space with byte-length accounting where Go compares byte sizes.
// ---------------------------------------------------------------------------

export interface ResultFragment {
  /** 1 + the newline count before the block (informational; the API wire
   *  carries only content + matches) */
  startLine: number;
  /** the block text (a rune-boundary-clipped slice — TruncateStringBytes) */
  content: string;
  /** match ranges in STRING offsets relative to the fragment content */
  matches: MatchRange[];
}

/** Go `util.TruncateStringBytes` — cut at a rune boundary ≤ limit bytes. */
export function truncateStringBytes(s: string, limit: number): string {
  if (utf8ByteLength(s) <= limit) return s;
  let acc = 0;
  let i = 0;
  for (const r of s) {
    acc += utf8ByteLength(r);
    if (acc > limit) {
      return s.slice(0, i);
    }
    i += r.length;
  }
  return s;
}

export function buildResultFragments(content: string, matches: MatchRange[]): ResultFragment[] {
  if (matches.length === 0) return [];
  // Per-match byte offsets for the byte-size comparisons (Go's indexes are
  // bytes; the '\n' alignment makes string-space newline searches agree).
  const byteOf = (index: number): number => utf16ToBytes(content, index);
  const blocks: Array<{ start: number; end: number }> = [];
  for (const match of matches) {
    const lineStart = content.lastIndexOf("\n", match.start - 1) + 1;
    // Go: LastIndexByte(content[:max(0, lineStart-1)], '\n') + 1 — the start
    // of the line BEFORE the match's line (0 when there is none).
    const prevBoundary = Math.max(0, lineStart - 1);
    let start = prevBoundary === 0 ? 0 : content.lastIndexOf("\n", prevBoundary - 1) + 1;
    // Go: utf8.DecodeRuneInString(content[match.Start:match.End]) — the first
    // match rune's BYTE length (a surrogate pair is one rune).
    const matchRuneSize = utf8ByteLength(String.fromCodePoint(content.codePointAt(match.start) ?? 0));
    if (byteOf(match.start) + matchRuneSize - byteOf(start) > MAX_RESULT_FRAGMENT_SIZE) {
      start = lineStart;
      if (byteOf(match.start) + matchRuneSize - byteOf(start) > MAX_RESULT_FRAGMENT_SIZE) {
        start = match.start;
      }
    }
    let end = match.end - 1;
    // limit := min(len(content), end+MaxResultFragmentSize+utf8.UTFMax)
    const endBytes = byteOf(end);
    const limitBytes = Math.min(utf8ByteLength(content), endBytes + MAX_RESULT_FRAGMENT_SIZE + 4);
    const limit = byteLimitToStringIndex(content, limitBytes);
    for (let i = 0; i < 2; i++) {
      const newline = content.indexOf("\n", end);
      if (newline < 0 || newline >= limit) {
        end = limit;
        break;
      }
      end = newline + 1;
    }
    const previous = blocks[blocks.length - 1];
    if (previous && start <= previous.end) {
      // Go: mergedEnd = previous.Start + len(TruncateStringBytes(
      //   content[previous.Start:max(previous.End, end)], Max)) — a BYTE
      // offset; the merge condition compares it with match.Start+matchRuneSize.
      const truncatedMerge = truncateStringBytes(
        content.slice(previous.start, Math.max(previous.end, end)),
        MAX_RESULT_FRAGMENT_SIZE,
      );
      const mergedEndBytes = byteOf(previous.start) + utf8ByteLength(truncatedMerge);
      if (byteOf(match.start) + matchRuneSize <= mergedEndBytes) {
        previous.end = previous.start + truncatedMerge.length;
        continue;
      }
      start = previous.end;
    }
    if (blocks.length === MAX_RESULT_FRAGMENTS) {
      break;
    }
    const truncated = truncateStringBytes(content.slice(start, end), MAX_RESULT_FRAGMENT_SIZE);
    blocks.push({ start, end: start + truncated.length });
  }
  const fragments: ResultFragment[] = [];
  for (const block of blocks) {
    const fragment: ResultFragment = {
      startLine: 1 + countNewlinesBefore(content, block.start),
      content: content.slice(block.start, block.end),
      matches: [],
    };
    for (const match of matches) {
      if (match.start < block.end && match.end > block.start) {
        fragment.matches.push({
          start: Math.max(match.start, block.start) - block.start,
          end: Math.min(match.end, block.end) - block.start,
        });
      }
    }
    fragments.push(fragment);
  }
  return fragments;
}

/** Go's merge condition byte-compares match.Start - previous.Start; the
 *  string-space comparison rides the byteOf table above (Go:
 *  `match.Start+matchRuneSize <= mergedEnd`). */
function countNewlinesBefore(content: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 0x0a) count++;
  }
  return count;
}

/** A UTF-8 BYTE limit → the greatest string index whose cumulative byte
 *  offset ≤ the limit (never splits a rune). */
function byteLimitToStringIndex(content: string, bytes: number): number {
  let acc = 0;
  let i = 0;
  while (i < content.length) {
    const code = content.charCodeAt(i);
    const len = code >= 0xd800 && code <= 0xdbff ? 2 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (acc + len > bytes) return i;
    acc += len;
    i += len;
  }
  return content.length;
}

/** The wire conversion: fragment-relative STRING offsets → the swagger's
 *  "UTF-8 byte offsets in the fragment" (`CodeSearchTextMatchTerm.indices`). */
export function toWireIndices(fragmentContent: string, range: MatchRange): [number, number] {
  return [utf16ToBytes(fragmentContent, range.start), utf16ToBytes(fragmentContent, range.end)];
}

// ---------------------------------------------------------------------------
// The scan — gitgrep.PerformSearch over plain tree/blob reads.
// ---------------------------------------------------------------------------

export interface CodeSearchHit {
  path: string;
  commitId: string;
  /** the UTF-8-lossy decoded text ("" for non-text files — ReadFile's nil
   *  content posture) */
  content: string;
  /** match ranges in STRING offsets into `content` */
  matches: MatchRange[];
}

export interface CodeSearchScan {
  /** matched files in ls-tree order, BEFORE pagination (≤ 50) */
  hits: CodeSearchHit[];
  /** hits.length — upstream `int64(len(results))` */
  total: number;
  /** any cap exit: the 50-file result cap or a scan budget (upstream: the
   *  30-second grep deadline) */
  incomplete: boolean;
}

type Walked = { budget: true } | { budget: false; entry: TreeEntryJson; path: string };

/** The repo's eligible-file enumeration — `git ls-tree -r` order (depth-first
 *  in stored tree order; blobs only, regular+executable modes — upstream
 *  parseGitLsTreeOutput's IsRegular||IsExecutable filter). Symlinks
 *  (120000) and submodules (160000/commit entries) never index upstream. */
async function* walkFiles(reads: EngineReads, commitId: string, pathPrefix: string): AsyncGenerator<Walked> {
  let dirWalks = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    dirWalks++;
    if (dirWalks > MAX_TREE_DIRS) {
      yield { budget: true };
      return;
    }
    const tree = await reads.listTree(commitId, dir === "" ? undefined : dir);
    if (tree === null) continue;
    // Push dirs in reverse so the pop order preserves the stored (git-sorted)
    // entry order — `ls-tree -r`'s depth-first flattening.
    const dirs: string[] = [];
    for (const entry of tree.entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (pathPrefix !== "" && !path.startsWith(`${pathPrefix}/`)) {
        // The `:(literal)<path>/` pathspec: only the subtree qualifies; walk
        // the dirs ON the prefix path (an ancestor of it, or the prefix dir
        // itself), skip everything else.
        if (entry.type === "tree" && (pathPrefix.startsWith(`${path}/`) || path === pathPrefix)) {
          dirs.push(path);
        }
        continue;
      }
      if (entry.type === "tree") {
        dirs.push(path);
        continue;
      }
      if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100664" || entry.mode === "100755")) {
        yield { budget: false, entry, path };
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i] as string);
  }
}

/** The PerformSearch pipeline minus the grep prefilter (divergence 1):
 *  every IsSearchable file at `commitId` is content-checked by the matcher
 *  until the 50-file cap or a scan budget exits. */
export async function scanRepoCode(
  reads: EngineReads,
  commitId: string,
  query: SearchQuery,
  matcher: FileMatcher,
): Promise<CodeSearchScan> {
  const hits: CodeSearchHit[] = [];
  let incomplete = false;
  if (query.terms.length === 0) {
    return { hits, total: 0, incomplete };
  }
  let scanned = 0;
  for await (const walked of walkFiles(reads, commitId, query.path)) {
    if (walked.budget) {
      incomplete = true;
      break;
    }
    scanned++;
    if (scanned > MAX_SCANNED_FILES) {
      incomplete = true;
      break;
    }
    const file = walked.entry;
    if (!isSearchable(walked.path, file.size ?? 0)) continue;
    const blob = await reads.readBlob(commitId, walked.path);
    if (blob === null) continue;
    // The size gate re-checks the authoritative length (upstream gates on
    // ls-tree -l's size before reading).
    if (blob.data.byteLength > MAX_INDEXER_FILE_SIZE) continue;
    const content = isBinaryContent(blob.data) ? "" : new TextDecoder().decode(blob.data);
    const matches = matcher.matchFile(walked.path, content);
    if (matches === null) continue;
    if (hits.length === GIT_GREP_MAX_RESULT_LIMIT) {
      incomplete = true;
      break;
    }
    hits.push({ path: walked.path, commitId, content, matches });
  }
  return { hits, total: hits.length, incomplete };
}

/** `util.PaginateSlice` (gitgrep.go:148) — the page window over the ≤50 hits
 *  (page ≥ 1; pageSize ≤ 0 → the 50 default). */
export function paginateHits<T>(items: T[], page: number, pageSize: number): T[] {
  const p = Math.max(page, 1);
  const size = pageSize > 0 ? pageSize : GIT_GREP_MAX_RESULT_LIMIT;
  const start = (p - 1) * size;
  if (start >= items.length) return [];
  return items.slice(start, start + size);
}
