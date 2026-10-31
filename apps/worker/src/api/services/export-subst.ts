/**
 * git archive's export-subst expansion — the `$Format:…$` pretty-format
 * substitution (SPEC-0004 §2.4 archive row; the residuals-v1.3.2 item-8
 * export-subst arm). Upstream archives are a real `git archive` run
 * (modules/git/archive.go CreateArchive), so the semantics ARE git 2.43.0's,
 * ported from byte observations + the source of that exact version:
 *
 *   - archive.c format_subst: a byte scan for "$Format:" closed by the NEXT
 *     `$` byte — the marker may span newlines, and an unterminated marker
 *     "steals" the next `$` anywhere in the rest of the file (when NO `$`
 *     follows, the marker and the file tail stay literal). Literal bytes
 *     outside markers pass through untouched (binary-safe).
 *   - expansion runs on REGULAR file blobs only — archive.c
 *     object_file_to_archive gates it on S_ISREG, so symlinks (the archive
 *     entry carries the target as the link name) stream raw bytes
 *     (byte-observed: a marked symlink survives literal).
 *   - pretty.c placeholders over the ARCHIVED commit's fields: the honored
 *     set is %H %h %T %t %P %p %an %ae %aN %aE %al %aL %ad %aD %aI %ai %at
 *     %cn %ce %cN %cE %cl %cL %cd %cD %cI %ci %ct %s %f %b %B %d %D %% %n.
 *     The residual item's contract table (%H %h %T %P %an %ae %ad %aI %aD
 *     %at %cn %ce %cd %cI %ct %s %f %b %d %D %aN %aE %% %n) is the pinned
 *     subset; the extra names are the same helpers' siblings (RFC2822 and
 *     loose-ISO committer dates, local-part splits, raw message, tree/parent
 *     abbreviations) — each byte-observed on git 2.43.0 and pinned.
 *   - EVERYTHING else renders its `%` VERBATIM and scanning resumes at the
 *     next character (pretty.c's unknown arm: `%ZZ` renders "%ZZ", `%Zn`
 *     renders "%Zn" — the rescanned chars are plain literals): %ar/%cr
 *     relative dates (wall-clock + locale), %N notes,
 *     %e encoding header, %G* signature queries (no signature verification
 *     exists engine-side), %m revision marks, %xNN byte escapes, %C…/%w()/
 *     %(trailers) — all survive as literal text.
 *
 * Documented reductions (where git needs machinery the read RPCs do not
 * expose — the same boundary the dist-types read surface draws):
 *   - %h/%t/%p truncate to SUBST_ABBREV (7) hex — git's find_unique_abbrev
 *     starts at DEFAULT_ABBREV (7) and only GROWS past small-repo object
 *     counts; the disambiguation census is not on the read RPCs.
 *   - %d/%D decorations: log-tree.c load_ref_decorations(NULL,
 *     DECORATE_SHORT_REFS) decorates EVERY ref plus HEAD; display order is
 *     HEAD first (rendered "HEAD -> <branch>" when the symref target is
 *     decorated too, consuming its item), then the other refs in REVERSE
 *     full-name byte order (for_each_ref iterates name-sorted and
 *     add_name_decoration prepends). refs/tags/* render "tag: <short>" — an
 *     annotated tag's ref decorates the commit its PEELED oid reaches; a
 *     lightweight tag its own target. prettify_refname strips ONLY
 *     refs/heads/, refs/tags/ and refs/remotes/ — any other ref renders its
 *     FULL name (refs/pull/7/head, refs/custom/z — both byte-observed).
 *   - %aN/%aE/%cN/%cE mailmap: read_mailmap's bare-repository posture —
 *     `HEAD:.mailmap` is the only live source server-side (no worktree file,
 *     no mailmap.file config in upstream Gitea), so the map rides the repo's
 *     HEAD ref, never the archived tree (byte-observed: an older commit's
 *     author maps while archived). The parser is mailmap.c's: `#`-first lines
 *     are comments; a line carries one or two `Name <email>` pairs (the FIRST
 *     pair's email may not be empty); a single-pair line keys on its own
 *     email and rewrites the name only; two-pair lines key on the second
 *     email and rewrite name and/or email, scoped to the second name when
 *     present (the namemap, last line wins) with a per-email fallback. Both
 *     lookups are case-insensitive (read_mailmap sets map->cmp = namemap_cmp).
 *   - a failed context read degrades: refs → no decorations, .mailmap →
 *     identity, and a missing COMMIT leaves `$Format:…$` literals intact —
 *     the archive never fails on substitution context (the bytes exist; the
 *     route already proved the ref resolves before this runs).
 */

/** One git identity line's parsed surface (engine `Person`'s structural twin). */
export interface SubstPerson {
  name: string;
  email: string;
  /** unix seconds */
  time: number;
  /** the commit's ORIGINAL "+HHMM"/"-HHMM" offset — every date rendering uses it */
  tz: string;
}

/** The archived commit's fields (engine `CommitJson`'s structural twin). */
export interface SubstCommit {
  oid: string;
  tree: string;
  parents: string[];
  author: SubstPerson;
  committer: SubstPerson;
  /** the raw message after the header separator — git's %B text */
  message: string;
}

/** One ref row (engine `RefsResult["refs"][number]`'s structural twin). */
export interface SubstRef {
  name: string;
  target: string;
  /** annotated tags: the peeled commit oid */
  peeled?: string;
}

/** Everything the renderer needs, assembled once per archive by the caller. */
export interface SubstContext {
  commit: SubstCommit;
  /** decoration items in git's display order ([] = no decorations) */
  decorations: string[];
  mailmap: Mailmap;
}

/** git's DEFAULT_ABBREV floor — the small-repo result of find_unique_abbrev. */
export const SUBST_ABBREV = 7;

// ---------------------------------------------------------------------------
// $Format:…$ marker scan (archive.c format_subst, byte-level)
// ---------------------------------------------------------------------------

const MARKER = new TextEncoder().encode("$Format:");
const DOLLAR = new TextEncoder().encode("$")[0] as number;

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfByte(haystack: Uint8Array, byte: number, from: number): number {
  for (let i = from; i < haystack.length; i++) {
    if (haystack[i] === byte) return i;
  }
  return -1;
}

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

/**
 * Expand every `$Format:<fmt>$` marker in `bytes` with the pretty-format
 * rendering of `<fmt>` over `ctx`. Byte-faithful: literal runs (including a
 * trailing unterminated `$Format:` and any binary bytes) are copied verbatim;
 * only the span from `$Format:` to the next `$` is replaced. Expansion is the
 * caller's attribute gate — regular files only (symlinks stream raw).
 */
export function expandExportSubst(bytes: Uint8Array, ctx: SubstContext): Uint8Array {
  const parts: Uint8Array[] = [];
  let scan = 0;
  for (;;) {
    const start = indexOfBytes(bytes, MARKER, scan);
    if (start < 0) break;
    const close = indexOfByte(bytes, DOLLAR, start + MARKER.length);
    if (close < 0) break; // unterminated, no further `$`: the tail stays literal
    parts.push(bytes.subarray(scan, start));
    const format = DECODER.decode(bytes.subarray(start + MARKER.length, close));
    parts.push(ENCODER.encode(renderFormat(format, ctx)));
    scan = close + 1;
  }
  if (parts.length === 0) return bytes;
  parts.push(bytes.subarray(scan));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subject/body split (pretty.c parse_commit_message + format_subject)
// ---------------------------------------------------------------------------

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\v" || ch === "\f" || ch === "\r";
}

/** is_blank_line's rule: strip the TRAILING git-isspace run only. */
function rightTrim(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1] as string)) end--;
  return text.slice(0, end);
}

/** parse_name_and_email's name rule: strip BOTH ends of the pre-`<` text. */
function trimSpaces(text: string): string {
  let start = 0;
  const right = rightTrim(text);
  while (start < right.length && isSpace(right[start] as string)) start++;
  return right.slice(start);
}

export interface MessageSplit {
  /** the subject paragraph's lines, right-trimmed (%s joins them with " ") */
  subjectLines: string[];
  /** %f's input: the subject region's first line, up to its newline */
  firstLine: string;
  /** %b: from the first non-blank line after the subject paragraph to the end */
  body: string;
}

/**
 * git's message split: leading blank lines are skipped; the subject
 * paragraph's lines are kept each RIGHT-TRIMMED of git-isspace runs; the body
 * starts at the first non-blank line after that paragraph and runs to the END
 * of the raw message (trailing newlines included). `%B` ignores this split —
 * it is the raw `message` verbatim.
 */
export function splitMessage(message: string): MessageSplit {
  const lineEnd = (from: number): number => {
    const idx = message.indexOf("\n", from);
    return idx === -1 ? message.length : idx;
  };
  let pos = 0;
  while (pos < message.length && rightTrim(message.slice(pos, lineEnd(pos))) === "") {
    const end = lineEnd(pos);
    if (end === message.length) {
      pos = message.length;
      break;
    }
    pos = end + 1;
  }
  const subjectOff = pos;
  const subjectLines: string[] = [];
  while (pos < message.length) {
    const end = lineEnd(pos);
    const line = rightTrim(message.slice(pos, end));
    if (line === "") break;
    subjectLines.push(line);
    if (end === message.length) {
      pos = message.length;
      break;
    }
    pos = end + 1;
  }
  while (pos < message.length) {
    const end = lineEnd(pos);
    if (rightTrim(message.slice(pos, end)) !== "") break;
    if (end === message.length) {
      pos = message.length;
      break;
    }
    pos = end + 1;
  }
  return {
    subjectLines,
    firstLine: message.slice(subjectOff, lineEnd(subjectOff)),
    body: message.slice(pos), // slice(length) is "" — the no-body arm falls out
  };
}

/** %f — pretty.c format_sanitized_subject over the subject's FIRST LINE. */
function sanitizedSubject(firstLine: string): string {
  let out = "";
  let space = 2; // 2 = nothing emitted yet (no leading dash), 1 = a run is pending
  const chars = Array.from(firstLine);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (isTitleChar(ch)) {
      if (space === 1) out += "-";
      space = 0;
      out += ch;
      if (ch === ".") {
        while (chars[i + 1] === ".") i++; // consecutive dots collapse onto one
      }
    } else {
      space |= 1;
    }
  }
  while (out.endsWith(".") || out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

function isTitleChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "." || ch === "_"
  );
}

// ---------------------------------------------------------------------------
// Dates (date.c show_date; every mode renders in the commit's OWN offset)
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "+0530"/"-0800" → the offset in minutes (the engine validates the shape). */
function tzMinutes(tz: string): number {
  if (!/^[+-]\d{4}$/.test(tz)) return 0;
  const sign = tz[0] === "-" ? -1 : 1;
  return sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
}

/** The commit's tz as date.c's `%+05d`: sign + four digits. */
function tzRender(tz: string): string {
  const minutes = tzMinutes(tz);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/** UTC calendar fields of `epoch + offset` — date.c's time_to_tm(time, tz). */
function calendar(epochSecs: number, tz: string): {
  year: string;
  mon: string;
  day: string;
  hh: string;
  mm: string;
  ss: string;
  weekday: string;
  month: string;
} {
  const d = new Date((epochSecs + tzMinutes(tz) * 60) * 1000);
  return {
    year: String(d.getUTCFullYear()),
    mon: pad2(d.getUTCMonth() + 1),
    day: pad2(d.getUTCDate()),
    hh: pad2(d.getUTCHours()),
    mm: pad2(d.getUTCMinutes()),
    ss: pad2(d.getUTCSeconds()),
    weekday: WEEKDAYS[d.getUTCDay()] as string,
    month: MONTHS[d.getUTCMonth()] as string,
  };
}

export type DateMode = "normal" | "rfc2822" | "iso8601" | "iso8601-strict" | "unix";

/** show_date's archive modes — DATE_NORMAL is the archive context's default. */
export function renderDate(epochSecs: number, tz: string, mode: DateMode): string {
  if (mode === "unix") return String(epochSecs);
  const c = calendar(epochSecs, tz);
  const tzStr = tzRender(tz);
  const dayNoPad = String(Number(c.day)); // %d — the day is never zero-padded
  switch (mode) {
    case "normal": // "Thu Mar 5 07:08:09 2026 +0530"
      return `${c.weekday} ${c.month} ${dayNoPad} ${c.hh}:${c.mm}:${c.ss} ${c.year} ${tzStr}`;
    case "rfc2822": // "Thu, 5 Mar 2026 07:08:09 +0530"
      return `${c.weekday}, ${dayNoPad} ${c.month} ${c.year} ${c.hh}:${c.mm}:${c.ss} ${tzStr}`;
    case "iso8601": // "2026-03-05 07:08:09 +0530"
      return `${c.year}-${c.mon}-${c.day} ${c.hh}:${c.mm}:${c.ss} ${tzStr}`;
    case "iso8601-strict": // "2026-03-05T07:08:09+05:30"
      return `${c.year}-${c.mon}-${c.day}T${c.hh}:${c.mm}:${c.ss}${tzStr.slice(0, 3)}:${tzStr.slice(3)}`;
  }
}

// ---------------------------------------------------------------------------
// Mailmap (mailmap.c parse + map_user)
// ---------------------------------------------------------------------------

export interface MailmapEntry {
  name?: string;
  email?: string;
}

interface MailmapEmailEntry {
  simple: MailmapEntry;
  /** keyed by LOWERCASED old name (the namemap's strcasecmp) */
  named: Map<string, MailmapEntry>;
}

export interface Mailmap {
  /** keyed by LOWERCASED old email (the top map's strcasecmp) */
  byEmail: Map<string, MailmapEmailEntry>;
}

/** The identity map when no .mailmap exists at HEAD. */
export const EMPTY_MAILMAP: Mailmap = { byEmail: new Map() };

/**
 * One `Name <email>` pair (parse_name_and_email): the name is the text before
 * `<`, space-trimmed, and may be empty; the email runs between the brackets.
 * Only the FIRST pair of a line rejects an empty email (allow_empty_email=0).
 */
function parseNameAndEmail(text: string, allowEmpty: boolean): { name?: string; email: string; rest: string } | null {
  const lt = text.indexOf("<");
  if (lt < 0) return null;
  const gt = text.indexOf(">", lt + 1);
  if (gt < 0) return null;
  const email = text.slice(lt + 1, gt);
  if (email === "" && !allowEmpty) return null;
  const name = trimSpaces(text.slice(0, lt));
  return {
    ...(name === "" ? {} : { name }),
    email,
    rest: text.slice(gt + 1),
  };
}

/**
 * Parse `.mailmap` text (mailmap.c read_mailmap_string + read_mailmap_line +
 * add_mapping). `#`-first lines are comments; each remaining line carries one
 * or two `Name <email>` pairs. A single-pair line keys on its own email and
 * rewrites the name only; two-pair lines key on the second email — rewriting
 * name and/or email, scoped to the second name when present (last line wins).
 */
export function parseMailmap(text: string): Mailmap {
  const map: Mailmap = { byEmail: new Map() };
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line === "") continue;
    const first = parseNameAndEmail(line, false);
    if (first === null) continue;
    const second = first.rest === "" ? null : parseNameAndEmail(first.rest, true);
    // add_mapping's swap: a single-pair line keys on its own email and only
    // carries a new name; a two-pair line's FIRST pair is the new identity
    // and the SECOND pair the old one it replaces.
    const oldEmail = second === null ? first.email : second.email;
    const oldName = second === null ? undefined : second.name;
    const newEmail = second === null ? undefined : first.email;
    let entry = map.byEmail.get(oldEmail.toLowerCase());
    if (entry === undefined) {
      entry = { simple: {}, named: new Map() };
      map.byEmail.set(oldEmail.toLowerCase(), entry);
    }
    if (oldName === undefined) {
      if (first.name !== undefined) entry.simple.name = first.name;
      if (newEmail !== undefined) entry.simple.email = newEmail;
    } else {
      entry.named.set(oldName.toLowerCase(), { name: first.name, email: newEmail });
    }
  }
  return map;
}

/**
 * map_user: the commit's email picks the entry (case-insensitive); an entry
 * with name-scoped rows looks the NAME up too (case-insensitive), falling
 * back to the simple arm on a miss. An entry carrying neither a name nor an
 * email leaves the identity untouched.
 */
export function applyMailmap(map: Mailmap, person: { name: string; email: string }): { name: string; email: string } {
  const entry = map.byEmail.get(person.email.toLowerCase());
  if (entry === undefined) return person;
  const chosen = entry.named.size > 0 ? (entry.named.get(person.name.toLowerCase()) ?? entry.simple) : entry.simple;
  if (chosen.name === undefined && chosen.email === undefined) return person;
  return {
    name: chosen.name ?? person.name,
    email: chosen.email ?? person.email,
  };
}

// ---------------------------------------------------------------------------
// Decorations (log-tree.c load_ref_decorations + format_decorations)
// ---------------------------------------------------------------------------

/** prettify_refname: strip ONLY these three prefixes; anything else renders full. */
function prettifyRefName(name: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/**
 * The decoration items for one commit, in git's display order: HEAD first
 * ("HEAD -> <branch short>" when the HEAD symref target is decorated too —
 * its own item is consumed), then the remaining refs in REVERSE full-name
 * byte order. refs/tags/* render "tag: <short>"; refs/heads/* and
 * refs/remotes/* render short; any other ref renders its FULL name.
 */
export function buildDecorations(refs: readonly SubstRef[], head: string | null, commitOid: string): string[] {
  const pointed = refs.filter((r) => r.target === commitOid || r.peeled === commitOid);
  pointed.reverse();
  const headEntry = head === null ? undefined : pointed.find((r) => r.name === head);
  const items: string[] = [];
  if (headEntry !== undefined) items.push(`HEAD -> ${prettifyRefName(headEntry.name)}`);
  for (const ref of pointed) {
    if (ref === headEntry) continue;
    const short = prettifyRefName(ref.name);
    items.push(ref.name.startsWith("refs/tags/") ? `tag: ${short}` : short);
  }
  return items;
}

// ---------------------------------------------------------------------------
// The placeholder renderer (pretty.c format_commit_item over the honored set)
// ---------------------------------------------------------------------------

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at < 0 ? email : email.slice(0, at);
}

function renderPerson(who: SubstPerson, part: string, mailmap: Mailmap): string | null {
  switch (part) {
    case "n":
      return who.name;
    case "e":
      return who.email;
    case "N":
      return applyMailmap(mailmap, who).name;
    case "E":
      return applyMailmap(mailmap, who).email;
    case "l":
      return localPart(who.email);
    case "L":
      return localPart(applyMailmap(mailmap, who).email);
    case "d":
      return renderDate(who.time, who.tz, "normal");
    case "D":
      return renderDate(who.time, who.tz, "rfc2822");
    case "I":
      return renderDate(who.time, who.tz, "iso8601-strict");
    case "i":
      return renderDate(who.time, who.tz, "iso8601");
    case "t":
      return String(who.time);
    default:
      return null;
  }
}

/**
 * Render one format string (the text between `$Format:` and `$`). Unknown
 * placeholders emit their `%` and resume scanning at the next character —
 * pretty.c's unknown arm. `%%` is the literal-% escape, `%n` a newline.
 */
export function renderFormat(format: string, ctx: SubstContext): string {
  const { commit, decorations, mailmap } = ctx;
  const split = splitMessage(commit.message);
  let out = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] !== "%") {
      out += format[i] as string;
      i += 1;
      continue;
    }
    if (format.length - i < 2) {
      out += "%"; // a lone trailing '%'
      i += 1;
      continue;
    }
    const head = format[i + 1] as string;
    const tail = format[i + 2];
    let text: string | null = null;
    let consumed = 2;
    if (head === "%") {
      text = "%";
    } else if (head === "n") {
      text = "\n";
    } else if (head === "H") {
      text = commit.oid;
    } else if (head === "h") {
      text = commit.oid.slice(0, SUBST_ABBREV);
    } else if (head === "T") {
      text = commit.tree;
    } else if (head === "t") {
      text = commit.tree.slice(0, SUBST_ABBREV);
    } else if (head === "P") {
      text = commit.parents.join(" ");
    } else if (head === "p") {
      text = commit.parents.map((p) => p.slice(0, SUBST_ABBREV)).join(" ");
    } else if (head === "a" || head === "c") {
      if (tail !== undefined) {
        text = renderPerson(head === "a" ? commit.author : commit.committer, tail, mailmap);
        consumed = 3; // "%an"-shaped placeholders carry the part char too
      }
    } else if (head === "s") {
      text = split.subjectLines.join(" ");
    } else if (head === "f") {
      text = sanitizedSubject(split.firstLine);
    } else if (head === "b") {
      text = split.body;
    } else if (head === "B") {
      text = commit.message;
    } else if (head === "d") {
      text = decorations.length > 0 ? ` (${decorations.join(", ")})` : "";
    } else if (head === "D") {
      text = decorations.join(", ");
    }
    if (text === null) {
      out += "%"; // unknown placeholder: the % is literal, scanning resumes here
      i += 1;
    } else {
      out += text;
      i += consumed;
    }
  }
  return out;
}
