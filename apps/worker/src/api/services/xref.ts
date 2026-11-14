/**
 * The cross-reference (xref) WRITER lane — census B-46 / §7.4 row I20.
 * Upstream at pin: the reference regex family + extraction live in
 * `gitea/modules/references/references.go`, the write machinery in
 * `gitea/models/issues/issue_xref.go`, and both are reached from the
 * MODEL layer so every create/edit route inherits the scan.
 *
 * Three layers, ported whole:
 *
 *   1. THE REGEX FAMILY (references.go:22-63) — `validNamePattern`,
 *      `issueNumericPattern`, `issueAlphanumericPattern`,
 *      `crossReferenceIssueNumericPattern`, `crossReferenceCommitPattern`,
 *      `spaceTrimmedPattern`, `timeLogPattern` and the AppURL-built
 *      `giteaIssuePullPattern`, each verbatim with ONE mechanical
 *      translation (the mentions parser's precedent,
 *      services/mentions/parser.ts:71-74): Go's `\s` is the ASCII class
 *      `[\t\n\f\r ]` while JS `\s` also eats Unicode spaces, so the class is
 *      spelled out. `[0-9a-zA-Z-_\.]` becomes `[0-9A-Za-z._-]` (identical
 *      class: after a range, `-` is literal in both engines).
 *
 *      DERIVED (references.go:433-556): the WRITER scan
 *      (`findAllIssueReferencesBytes`) runs ONLY the numeric + cross-reference
 *      numeric loops, the out-of-band links loop and the time-log tail.
 *      `issueAlphanumericPattern` (ABC-1234) and `crossReferenceCommitPattern`
 *      (owner/repo@sha) are RENDER-ONLY —
 *      `FindRenderizableReferenceAlphanumeric` (:415) and
 *      `FindRenderizableCommitCrossReference` (:369) feed the markup
 *      renderer/external trackers, never the xref rows. The family is ported
 *      and pinned here anyway (references_test.go's pattern matrices are
 *      gold); only the numeric family reaches the writer — exactly upstream.
 *
 *   2. THE EXTRACTION (references.go:147-624) — the keyword compiler
 *      (`makeKeywordsPat`: `(?:\s|^|\(|\[)(kw…):? $` anchored at the END of
 *      the window prefix; defaults from modules/setting/repository.go:202-203;
 *      `issueKeywordWindow` = max(RuneCount*UTFMax+3) = 35 bytes),
 *      `convertFullHTMLReferencesToShortRefs` (:263-327 — the AppURL URL →
 *      `owner/repo#N` rewrite, the TITLE path), the mdstripper
 *      (modules/markup/mdstripper/mdstripper.go — the BODY path: strip +
 *      out-of-band links + the same-host autolink rewrite), and
 *      `findAllIssueReferencesBytes` (:433-556) with `getCrossReference`
 *      (:558-607) and `findActionKeywords` (:609-624).
 *
 *      The mdstripper here extends the landed mention strip (which keeps text
 *      only) with the two arms the xref scan needs: `ast.Link` destinations
 *      collected out-of-band (mdstripper.go:57-59, WalkSkipChildren) and
 *      `ast.AutoLink` processed by `processAutoLink` (:83-124) — a same-host
 *      `/owner/repo/(issues|pulls)/N` autolink is rewritten INTO the stripped
 *      text as `owner/repo#N`; every other autolink goes to links. DERIVED
 *      quirk kept verbatim: `processAutoLink` trims the AppURL PATH off the
 *      link path before the 5-part check (:104), and AppURL is normalized to
 *      a trailing slash, so on root-path installs the trim eats the leading
 *      `/`, the split yields 4 parts, and EVERY autolink goes out-of-band to
 *      links — the in-text rewrite arm is dead there, which is exactly why
 *      references_test.go's URL fixtures carry `RefLocation: nil` (they come
 *      back through the links arm). The strip is a markdown-it walk with the
 *      landed mention strip's semantics (same `html: true, linkify: true,
 *      typographer: false` posture) — linkify fuzzy matching is OFF
 *      (`fuzzyLink/fuzzyEmail false`) because upstream's Linkify
 *      (modules/markup/common/linkify.go:21-46) matches only http/https/ftp
 *      and `www.` prefixes, never scheme-less hosts or emails.
 *
 *      Positions: Go matches BYTES; the fixtures' RefSpans are byte offsets
 *      (e.g. the Spanish `Cerró` row pins {Start:7} — the ó is two bytes).
 *      Scanning runs on JS string indices (so the keyword regex keeps its
 *      Unicode case folding — TestParseCloseKeywords pins `CERRÓ` matching
 *      `cerró`), and every reported span is converted to UTF-8 byte offsets
 *      through `ByteMap`. `findActionKeywords`' window is BYTE-based
 *      (`issueKeywordWindow`); a window cut landing mid-codepoint prepends
 *      U+FFFD placeholders — Go's own behavior for invalid UTF-8 under the
 *      regexp (each bad byte decodes as one RuneError, width 1).
 *
 *   3. THE WRITERS (models/issues/issue_xref.go) — `AddCrossReferences`
 *      (:60-75: type = CommentTypePullRef (6) when the origin is a PR else
 *      CommentTypeIssueRef (3); scans title with the non-markdown entry and
 *      body with the markdown entry), `getCrossReferences` (:136-176), the
 *      resolution gates of `verifyReferencedIssue` (:193-247), the
 *      self-reference skip + action-upgrade dedupe of
 *      `updateCrossReferenceList` (:178-190), the remove-old neuter/keep fold
 *      of `createCrossReferences` (:77-134) and the row shape of the
 *      `CreateComment` opts (:110-123). Call sites (all model-layer):
 *      issue create `NewIssueWithIndex` tail (issue_update.go:449) — which
 *      PR creation SHARES (models/issues/pull.go:478 NewPullRequest →
 *      NewIssueWithIndex), title edit `ChangeIssueTitle` (issue_update.go:217)
 *      and body edit `ChangeIssueContent` (issue_update.go:345), both with
 *      removeOld=true. The COMMENT arms land in the same lane through
 *      `syncCommentCrossReferences` — `Comment.AddCrossReferences`
 *      (issue_xref.go:228-246) funnels into the SAME `createCrossReferences`
 *      upstream: it gates on `CommentType.HasContentSupport()`
 *      (comment.go:180-186 — types 0 Comment / 21 Code / 22 Review / 32
 *      DismissReview), scans ONLY the comment content through the markdown
 *      entry (`c.Issue.createCrossReferences(ctx, xrefCtx, "", c.Content)`),
 *      always writes CommentTypeCommentRef (5) rows carrying
 *      `ref_comment_id`, and passes `OrigComment` — which alone kills the
 *      same-repo merger exception in `verifyReferencedIssue` (:225-232's
 *      `|| ctx.OrigComment != nil`). Upstream call sites: comment CREATE
 *      `CreateComment` (models/issues/comment.go:920, removeOld=false —
 *      every content-supporting type, the type-4 commit-ref rows NOT
 *      included: `HasContentSupport()` is false for CommentTypeCommitRef, so
 *      the B-47 push walk's ref comments scan nothing upstream either —
 *      derived no-op, recorded), comment EDIT `UpdateComment` (comment.go:1204,
 *      removeOld=true — the neuter+rewrite keyed (origin issue, origin
 *      comment)), comment DELETE `DeleteComment` → `neuterCrossReferences`
 *      (comment.go:1234 → issue_xref.go:43-53: active rows — ref_action in
 *      none/closes/reopens — with `ref_issue_id` = the comment's issue and
 *      `ref_comment_id` = the comment become neutered; the rows sit on the
 *      REFERENCED issues, so the delete cascades cross-issue by ref
 *      coordinates). The type-5 rows fire NO webhook upstream — they are
 *      model-layer `CreateComment` inserts and the notifiers fire only in the
 *      service `CreateIssueComment`, once, for the USER comment.
 *
 *      Divergences, each recorded:
 *      - num_comments: upstream counts ONLY Comment+Review types
 *        (ConversationCountedCommentType, comment.go:209-211) and xref rows
 *        don't bump it; THIS repo's recorded convention counts system
 *        comments (src/db/schema.ts `numComments` doc) and every sibling
 *        writer bumps — the xref writer bumps the referenced issue's
 *        num_comments + updated_unix (upstream DOES bump updated_unix for
 *        every comment, comment.go:956).
 *      - the external-tracker demotion arm (issue_xref.go:213-215) has no
 *        counterpart: our schema carries no external-tracker unit.
 *      - AppURL: the services carry no global setting; the caller threads the
 *        request origin (`appUrl`). Callers without one get upstream's
 *        nil-pattern arm ("No GiteaIssuePullPattern pattern", references.go:
 *        336): short refs still scan, AppURL-prefixed full URLs do not.
 *      - doer null (our poster-less rows): upstream never runs this path
 *        without a doer; a null doer reads the anonymous posture (public
 *        repos only) and never passes the actionable-ref poster/writer
 *        exception, mirroring GetDoerRepoPermission(nil)'s read-only rank.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

import { comments, issues, users } from "../../db/schema";
import { CommentType, RefAction } from "../../issues/comment-types";
import { isUserBlockedBy } from "./blocks";
import { loadRepoSettings } from "./repo-settings";
import {
  canViewRepositoryWithTeams,
  doerRepoAccessMode,
  findRepositoryById,
  findRepositoryByPath,
  type RepositoryRow,
  type RepositoryWithOwner,
  type Viewer,
} from "./repository";

/** Statement type accepted by drizzle's D1 `batch` (the service-layer pattern). */
type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];

// ---------------------------------------------------------------------------
// The regex family (references.go:22-63 verbatim; see the module header for
// the one mechanical translation).
// ---------------------------------------------------------------------------

/** `validNamePattern` (:25) — the most basic user/repository name check. */
export const VALID_NAME_PATTERN = /^[a-z0-9_.-]+$/;

/** Go's `\s` — the ASCII class (the mentions parser's spelled-out form). */
const S = "[\\t\\n\\f\\r ]";

/** `issueNumericPattern` (:35) — `#1287` / `!1287`. Group 1 = the reference. */
export const ISSUE_NUMERIC_SOURCE =
  `(?:${S}|^|\\(|\\[|'|")([#!][0-9]+)(?:${S}|$|\\)|\\]|'|"|[:;,.?!]${S}|[:;,.?!]$)`;

/**
 * `issueAlphanumericPattern` (:37) — `ABC-1234`, the external-tracker
 * reference. Render-only for the writer scan (module header).
 */
export const ISSUE_ALPHANUMERIC_SOURCE =
  `(?:${S}|^|\\(|\\[|"|')([A-Z]{1,10}-[1-9][0-9]*)(?:${S}|$|\\)|\\]|:|\\.(?:${S}|$)|"|'|,)`;

/**
 * `crossReferenceIssueNumericPattern` (:40) — `org/repo#12345`. Group 1 =
 * the full reference.
 */
export const CROSS_REFERENCE_NUMERIC_SOURCE =
  `(?:${S}|^|\\(|\\[)([0-9A-Za-z._-]+/[0-9A-Za-z._-]+[#!][0-9]+)(?:${S}|$|\\)|\\]|[:;,.?!]${S}|[:;,.?!]$)`;

/**
 * `crossReferenceCommitPattern` (:43) — `owner/repo@d8a994e` (7-40 hex at the
 * upstream comment; the class admits 7-64). Render-only for the writer scan.
 */
export const CROSS_REFERENCE_COMMIT_SOURCE =
  `(?:${S}|^|\\(|\\[)([0-9A-Za-z._-]+)/([0-9A-Za-z._-]+)@([0-9a-f]{7,64})(?:${S}|$|\\)|\\]|[:;,.?!]${S}|[:;,.?!]$)`;

/** `spaceTrimmedPattern` (:45) — the scan-loop notrail probe. */
export const SPACE_TRIMMED_SOURCE = `(?:.*[0-9A-Za-z_-])${S}`;

/** `timeLogPattern` (:47) — `@1h30m`-style time logs after a reference. */
export const TIME_LOG_SOURCE =
  `(?:${S}|^|\\(|\\[)(@([0-9]+([.,][0-9]+)?(?:w|d|m|h))+)(?:${S}|$|\\)|\\]|[:;,.?!]${S}|[:;,.?!]$)`;

/**
 * `giteaIssuePullPattern` (:186-190) built from the AppURL (:182-197): the
 * QuoteMeta'd base URL (normalized to one trailing slash, Gitea's own
 * AppURL posture) + `owner/repo/(issues|pulls)/N` with the same guards.
 * Groups as upstream: 1 = the lead guard (the "preamble"), 2 = owner/repo,
 * 3 = issues|pulls, 4 = the number. An empty appUrl answers null —
 * upstream's "No GiteaIssuePullPattern pattern" arm (:333-337).
 */
export function giteaIssuePullPattern(appUrl: string): RegExp | null {
  const base = appUrl.replace(/\/+$/, "");
  if (base === "") return null;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(${S}|^|\\(|\\[)` +
      escaped +
      `/` +
      `([0-9A-Za-z._-]+/[0-9A-Za-z._-]+)/` +
      `((?:issues)|(?:pulls))/` +
      `([0-9]+)` +
      `(?:${S}|$|\\)|\\]|[:;,.?!]${S}|[:;,.?!]$)`,
    "gd",
  );
}

/**
 * The default close/reopen keyword tables
 * (modules/setting/repository.go:202-203 verbatim).
 */
export const DEFAULT_CLOSE_KEYWORDS = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];
export const DEFAULT_REOPEN_KEYWORDS = ["reopen", "reopens", "reopened"];

// ---------------------------------------------------------------------------
// Action keywords (references.go:141-179, :609-624)
// ---------------------------------------------------------------------------

/** `parseKeywords` (:150-163): trim/lowercase; Unicode-letter words only. */
export function parseKeywords(words: string[]): string[] {
  const accepted: string[] = [];
  for (const raw of words) {
    const word = raw.trim().toLowerCase();
    if (/^[\p{L}]+$/u.test(word)) {
      accepted.push(word);
    }
    // upstream logs invalid keywords; there is no log surface here.
  }
  return accepted;
}

/** The compiled keyword patterns (`makeKeywordsPat` :141-148 + the window). */
export interface KeywordPatterns {
  close: RegExp | null;
  reopen: RegExp | null;
  /** `issueKeywordWindow` (:172-179): max(code points * UTFMax(4) + 3) bytes. */
  window: number;
}

/**
 * `makeKeywordsPat` (:141-148): `(?:\s|^|\(|\[)(kw…):? $` — the keyword must
 * sit immediately before the reference (the `$` anchors at the END of the
 * window prefix, so the keyword's trailing `: ` (optional) + space rides
 * directly against the reference's lead guard). An empty accepted set never
 * matches (:143-146). `(?i)` is the JS `iu` flags (Unicode case folding —
 * TestParseCloseKeywords pins `CERRÓ` matching `cerró`).
 */
export function makeKeywords(closeKeywords: string[], reopenKeywords: string[]): KeywordPatterns {
  const compile = (words: string[]): RegExp | null => {
    const accepted = parseKeywords(words);
    if (accepted.length === 0) return null;
    return new RegExp(`(?:${S}|^|\\(|\\[)(${accepted.join("|")}):? $`, "diu");
  };
  const close = compile(closeKeywords);
  const reopen = compile(reopenKeywords);
  let window = 0;
  for (const word of [...closeKeywords, ...reopenKeywords]) {
    window = Math.max(window, Array.from(word).length * 4 + 3); // utf8.RuneCountInString(word)*utf8.UTFMax+3
  }
  return { close, reopen, window };
}

/** The once-initialized default set (references.go:165-170's sync.Once). */
const DEFAULT_KEYWORDS = makeKeywords(DEFAULT_CLOSE_KEYWORDS, DEFAULT_REOPEN_KEYWORDS);

// ---------------------------------------------------------------------------
// Positions: Go byte offsets (the fixtures' unit) over JS string indices.
// ---------------------------------------------------------------------------

/** `references.RefSpan` (:135-139) — BYTE offsets, upstream's unit. */
export interface RefSpan {
  start: number;
  end: number;
}

/** UTF-8 byte length of a JS string. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    n += c > 0xffff ? 4 : c > 0x7ff ? 3 : c > 0x7f ? 2 : 1;
    if (c > 0xffff) i++;
  }
  return n;
}

/** String-index → UTF-8-byte-offset map for one document. */
export class ByteMap {
  private readonly offsets: Uint32Array;
  constructor(content: string) {
    this.offsets = new Uint32Array(content.length + 1);
    let n = 0;
    for (let i = 0; i < content.length; i++) {
      this.offsets[i] = n;
      const c = content.codePointAt(i)!;
      n += c > 0xffff ? 4 : c > 0x7ff ? 3 : c > 0x7f ? 2 : 1;
      if (c > 0xffff) i++;
    }
    this.offsets[content.length] = n;
  }
  /** Byte offset of the string index. */
  byteAt(index: number): number {
    return this.offsets[Math.min(index, this.offsets.length - 1)]!;
  }
  /** The string index holding `byte` — `exact` false when the byte lands
   *  mid-codepoint (Go's bad-byte window cut). */
  indexAtByte(byte: number): { index: number; exact: boolean } {
    let lo = 0;
    let hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid]! < byte) lo = mid + 1;
      else hi = mid;
    }
    return { index: lo, exact: this.offsets[lo] === byte };
  }
}

/**
 * `findActionKeywords` (:609-624): scan the prefix ending exactly where the
 * reference starts — `content[max(start-window, 0) : start]` — for the close
 * pattern, then the reopen pattern. The window is BYTE-based; a byte cut
 * landing mid-codepoint prepends U+FFFD placeholders (Go decodes each bad
 * byte as a width-1 RuneError, which can never be a keyword's lead guard or
 * letter). Returns the action and the keyword's BYTE span (the upstream
 * ActionLocation), a null span when none matched.
 */
export function findActionKeywords(
  content: string,
  start: number,
  bytes: ByteMap,
  patterns: KeywordPatterns = DEFAULT_KEYWORDS,
): { action: RefActionValue; location: RefSpan | null } {
  const startByte = bytes.byteAt(start);
  const windowStartByte = Math.max(startByte - patterns.window, 0);
  const windowStart = bytes.indexAtByte(windowStartByte);
  const prefixText = content.slice(windowStart.index, start);
  const placeholders = windowStart.exact ? 0 : windowStartByte - bytes.byteAt(windowStart.index);
  const prefix = "\uFFFD".repeat(placeholders) + prefixText;
  for (const [pattern, action] of [
    [patterns.close, RefAction.Closes],
    [patterns.reopen, RefAction.Reopens],
  ] as const) {
    if (pattern === null) continue;
    const m = pattern.exec(prefix);
    if (m !== null && m.indices !== undefined && m.indices[1] !== undefined) {
      const [gs, ge] = m.indices[1];
      // Byte offset of the capture: the placeholders contribute one byte each
      // (Go's width-1 bad bytes), then the real prefix text's UTF-8 length.
      const textStart = gs - placeholders;
      const byteStart = windowStartByte + placeholders + utf8Length(prefixText.slice(0, textStart));
      return { action, location: { start: byteStart, end: byteStart + utf8Length(prefix.slice(gs, ge)) } };
    }
  }
  return { action: RefAction.None, location: null };
}

// ---------------------------------------------------------------------------
// The extraction result shapes (references.go:83-118)
// ---------------------------------------------------------------------------

export type RefActionValue = (typeof RefAction)[keyof typeof RefAction];

/** `references.IssueReference` (:83-91) — the unverified reference. */
export interface IssueReference {
  index: number;
  owner: string;
  name: string;
  isPull: boolean;
  action: RefActionValue;
  timeLog: string;
}

/** `references.rawReference` (:108-118) — with the render locations (bytes). */
export interface RawReference extends IssueReference {
  issue: string;
  refLocation: RefSpan | null;
  actionLocation: RefSpan | null;
}

/** `rawToIssueReferenceList` (:120-133). */
function toIssueReference(raw: RawReference): IssueReference {
  return {
    index: raw.index,
    owner: raw.owner,
    name: raw.name,
    isPull: raw.isPull,
    action: raw.action,
    timeLog: raw.timeLog,
  };
}

// ---------------------------------------------------------------------------
// The AppURL rewrite (references.go:263-327; TestConvertFullHTMLReferences…
// :32-50)
// ---------------------------------------------------------------------------

/**
 * `convertFullHTMLReferencesToShortRefs` — rewrite AppURL-prefixed
 * `/owner/repo/(issues|pulls)/N` URLs into `owner/repo#N` / `owner/repo!N`
 * in place: everything from the END of the lead guard (the preamble,
 * match[3]) through the end of the number (match[9]) is replaced by
 * `owner/repo` + `#`|`!` + the number; the lead guard and the trailing guard
 * bytes ride along untouched (references.go:292-325's copies). The scan
 * resumes right after the rewritten number (Go's pos = endPos), i.e. at the
 * ORIGINAL offset just past the number — the remaining bytes are identical.
 * `pattern` must carry the `g` and `d` flags (giteaIssuePullPattern does).
 */
export function convertFullHtmlReferencesToShortRefs(pattern: RegExp, content: string): string {
  let pos = 0;
  let out = "";
  for (;;) {
    pattern.lastIndex = pos;
    const m = pattern.exec(content);
    if (m === null || m.indices === undefined) break;
    const lead = m.indices[1];
    const number = m.indices[4];
    const ownerRepo = m[2];
    const kind = m[3];
    const num = m[4];
    if (lead === undefined || number === undefined || ownerRepo === undefined || kind === undefined || num === undefined) break;
    out += content.slice(pos, lead[1]); // up to and including the lead guard
    out += ownerRepo + (kind === "pulls" ? "!" : "#") + num;
    pos = number[1];
  }
  return out + content.slice(pos);
}

// ---------------------------------------------------------------------------
// The mdstripper (modules/markup/mdstripper/mdstripper.go) — the BODY path.
// ---------------------------------------------------------------------------

/** The strip result: `StripMarkdownBytes`' (bcontent, links) pair. */
export interface StrippedMarkdown {
  text: string;
  links: string[];
}

/** The localhost pair mdstripper's renderer caches (mdstripper.go:14-17). */
function localhostOf(appUrl: string): { host: string; pathPrefix: string } {
  if (appUrl === "") return { host: "", pathPrefix: "/" };
  try {
    const u = new URL(appUrl);
    return { host: u.host.toLowerCase(), pathPrefix: u.pathname };
  } catch {
    return { host: "", pathPrefix: "" };
  }
}

/**
 * Go's `url.Parse` for the links arm (:477-483): a scheme-less link keeps its
 * RAW path with an empty host ("/user2/repo1/issues/921" parses fine in Go,
 * where `new URL` without a base throws — the `[two](/user2/repo1/issues/921)`
 * fixture depends on the raw-path arm). Scheme-carrying and protocol-relative
 * links go through the URL parser.
 */
function parseLinkForScan(link: string): { host: string; path: string } {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link)) {
    const u = new URL(link); // throws → the caller's catch (parse error)
    return { host: u.host, path: u.pathname };
  }
  if (link.startsWith("//")) {
    const u = new URL(`http:${link}`);
    return { host: u.host, path: u.pathname };
  }
  return { host: "", path: link };
}

/**
 * `stripRenderer.processAutoLink` (mdstripper.go:83-124): a same-host
 * `/owner/repo/(issues|pulls)/N` autolink is rewritten INTO the stripped text
 * as `owner/repo#N` / `owner/repo!N`; every other autolink goes out-of-band
 * to the links list. On root-path installs the AppURL-path trim eats the
 * leading `/` so the 5-part check always fails — the rewrite arm is dead and
 * every autolink lands in links (see the module header).
 */
function processAutoLink(href: string, localhost: { host: string; pathPrefix: string }, state: { text: string[]; empty: boolean }, links: string[]): void {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    links.push(href); // url.Parse error → out of band
    return;
  }
  if (u.host !== "" && u.host.toLowerCase() !== localhost.host) {
    links.push(href);
    return;
  }
  let path = u.pathname;
  if (localhost.pathPrefix !== "" && path.startsWith(localhost.pathPrefix)) {
    path = path.slice(localhost.pathPrefix.length);
  }
  const parts = path.split("/");
  if (parts.length !== 5 || parts[0] !== "") {
    links.push(href);
    return;
  }
  const sep = parts[3] === "issues" ? "#" : parts[3] === "pulls" ? "!" : null;
  if (sep === null) {
    links.push(href);
    return;
  }
  // Written directly to the render buffer: no separator discipline, and
  // `empty` is NOT cleared (mdstripper.go:114-120 vs processString :75-81).
  state.text.push(`${parts[1]}/${parts[2]}${sep}${parts[4]}`);
}

/**
 * The strip walk — the landed mention strip's semantics
 * (services/mentions/parser.ts:135-205) with the `empty` flag made real
 * (mdstripper.go:75-81: only processString clears it; the autolink rewrite
 * writes without touching it) and the two xref arms added. `prevWasText`
 * reproduces the coalesce rule (a separator precedes every text run unless
 * the previous sibling was Text).
 */
function stripInlines(
  tokens: Token[],
  state: { text: string[]; empty: boolean },
  links: string[],
  localhost: { host: string; pathPrefix: string },
): void {
  let prevWasText = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case "text":
      case "text_special": {
        if (!prevWasText && !state.empty) state.text.push("\n");
        state.text.push(token.content);
        state.empty = false;
        prevWasText = true;
        break;
      }
      case "softbreak":
      case "hardbreak": {
        if (!state.empty) state.text.push("\n");
        prevWasText = true;
        break;
      }
      case "code_inline": {
        // Code-span text is raw in goldmark — never emitted.
        prevWasText = false;
        break;
      }
      case "html_inline": {
        // Raw HTML is not an ast.Text node; the text after is a new run.
        prevWasText = false;
        break;
      }
      case "link_open": {
        // attrGet answers string | number | null — the wire href is a string.
        const href = String(token.attrGet("href") ?? "");
        if (token.markup === "autolink" || token.markup === "linkify") {
          // ast.AutoLink → processAutoLink (mdstripper.go:60-63).
          processAutoLink(href, localhost, state, links);
        } else {
          // ast.Link → processLink + WalkSkipChildren (:57-59): the
          // destination is collected out of band, the whole subtree drops.
          links.push(href);
        }
        let depth = 1;
        i++;
        for (; i < tokens.length && depth > 0; i++) {
          if (tokens[i]!.type === "link_open") depth++;
          else if (tokens[i]!.type === "link_close") depth--;
        }
        i--; // the loop's final increment stepped past link_close
        prevWasText = false;
        break;
      }
      case "image": {
        // ast.Image is walked (no case in the strip renderer): the alt text's
        // inline children ARE emitted, as a fresh run.
        if (token.children !== null) {
          stripInlines(token.children, state, links, localhost);
        }
        prevWasText = false;
        break;
      }
      default: {
        // strong/em/s/… container edges — fresh run before and after.
        prevWasText = false;
        break;
      }
    }
  }
}

/**
 * `mdstripper.StripMarkdownBytes` over markdown-it: block walk + inline strip
 * with the links collector. The strip instance parses with `html: true`
 * (goldmark's strip builds with html.WithUnsafe), `linkify: true` (the
 * Linkify extension) with fuzzy matching off (upstream's Linkify matches
 * http/https/ftp and www. only — module header), typographer off.
 */
export function stripMarkdown(content: string, appUrl: string): StrippedMarkdown {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  const localhost = localhostOf(appUrl);
  const state: { text: string[]; empty: boolean } = { text: [], empty: true };
  const links: string[] = [];
  for (const token of md.parse(content, {})) {
    if (token.type === "inline" && token.children !== null) {
      stripInlines(token.children, state, links, localhost);
    }
    // fence/code_block/html_block and block open/close pairs contribute no
    // text — goldmark's walk sees none.
  }
  return { text: state.text.join(""), links };
}

// ---------------------------------------------------------------------------
// findAllIssueReferencesBytes (references.go:433-556)
// ---------------------------------------------------------------------------

/** The scan context: the AppURL (+ optional non-default keywords, tests). */
export interface ReferenceScanOptions {
  appUrl: string;
  keywords?: KeywordPatterns;
}

/** Strict `strconv.ParseInt(issue, 10, 64)` (:569-572). */
function parseGoInt64(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  const min = -(2 ** 63);
  const max = 2 ** 63 - 1;
  return n >= min && n <= max ? n : null;
}

/**
 * `getCrossReference` (:558-607): split the span on the first `#`/`!`; an
 * unparsable index or (for links) an empty repo answers null; a repo splits
 * lowercase on `/` into exactly two valid-name parts. The action keyword is
 * looked up in `content` immediately before the span. Spans are byte offsets.
 */
function getCrossReference(
  content: string,
  start: number,
  end: number,
  fromLink: boolean,
  prOnly: boolean,
  bytes: ByteMap,
  keywords: KeywordPatterns,
): RawReference | null {
  const span = content.slice(start, end);
  const sep = span.search(/[#!]/);
  if (sep < 0) return null;
  const isPull = content[start + sep] === "!";
  if (prOnly && !isPull) return null;
  const repo = content.slice(start, start + sep);
  const issue = content.slice(start + sep + 1, end);
  const index = parseGoInt64(issue);
  if (index === null) return null;
  const action = findActionKeywords(content, start, bytes, keywords);
  const refLocation: RefSpan = { start: bytes.byteAt(start), end: bytes.byteAt(end) };
  if (repo === "") {
    if (fromLink) return null; // "Markdown links must specify owner/repo"
    return {
      index,
      owner: "",
      name: "",
      isPull,
      action: action.action,
      issue,
      refLocation,
      actionLocation: action.location,
      timeLog: "",
    };
  }
  const parts = repo.toLowerCase().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!VALID_NAME_PATTERN.test(owner) || !VALID_NAME_PATTERN.test(name)) return null;
  return {
    index,
    owner,
    name,
    isPull,
    action: action.action,
    issue,
    refLocation,
    actionLocation: action.location,
    timeLog: "",
  };
}

/**
 * `findAllIssueReferencesBytes` (:433-556): the numeric loop, the
 * cross-reference loop, the out-of-band links loop and the time-log tail.
 * The loops run full-string with a resuming lastIndex — equivalent to Go's
 * `content[pos:]` slices: the notrail backoff is dead (the capture classes
 * admit no `\s`, and the non-capturing probe would index a group that never
 * exists upstream — the mentions parser's precedent), so `pos` always points
 * at the trailing guard char, which satisfies the next match's `\s` lead just
 * as the slice-relative `^` would.
 */
export function findAllIssueReferencesBytes(
  content: string,
  links: string[],
  originalContent: string | null,
  options: ReferenceScanOptions,
): RawReference[] {
  const keywords = options.keywords ?? DEFAULT_KEYWORDS;
  const bytes = new ByteMap(content);
  const originalBytes = originalContent === null ? null : new ByteMap(originalContent);
  const ret: RawReference[] = [];

  for (const source of [ISSUE_NUMERIC_SOURCE, CROSS_REFERENCE_NUMERIC_SOURCE]) {
    const re = new RegExp(source, "gd");
    let pos = 0;
    for (;;) {
      re.lastIndex = pos;
      const m = re.exec(content);
      if (m === null || m.indices === undefined || m.indices[1] === undefined) break;
      const [gs, ge] = m.indices[1];
      const ref = getCrossReference(content, gs, ge, false, false, bytes, keywords);
      if (ref !== null) ret.push(ref);
      // notrail probe: dead by construction (see above) — pos = capture end.
      pos = ge;
    }
  }

  const localhost = localhostOf(options.appUrl);
  for (const link of links) {
    let parsed: { host: string; path: string };
    try {
      parsed = parseLinkForScan(link);
    } catch {
      continue; // url.Parse error → the link is ignored entirely (:477)
    }
    const host = parsed.host.toLowerCase();
    if (host !== "" && host !== localhost.host) continue;
    const parts = parsed.path.split("/");
    if (parts.length !== 5 || parts[0] !== "") continue;
    const sep = parts[3] === "issues" ? "#" : parts[3] === "pulls" ? "!" : null;
    if (sep === null) continue;
    const refBytes = `${parts[1]}/${parts[2]}${sep}${parts[4]}`;
    const ref = getCrossReference(refBytes, 0, refBytes.length, true, false, new ByteMap(refBytes), keywords);
    if (ref === null) continue;
    ref.refLocation = null; // :499 — link refs carry no location
    // The keyword is searched in the ORIGINAL content at the link's position,
    // backing off to the markdown `[` when the link is preceded by `(`
    // (:501-516). A link at position 0 gets no search (`idx > 0`).
    if (originalContent !== null && originalBytes !== null) {
      const idx = originalContent.indexOf(link);
      if (idx > 0) {
        let searchStart = idx;
        if (idx >= 2 && originalContent[idx - 1] === "(") {
          const bracketIdx = originalContent.slice(0, idx - 1).lastIndexOf("[");
          if (bracketIdx >= 0) searchStart = bracketIdx;
        }
        const action = findActionKeywords(originalContent, searchStart, originalBytes, keywords);
        ref.action = action.action;
        ref.actionLocation = action.location;
      }
    }
    ret.push(ref);
  }

  if (ret.length === 0) return ret;

  // The time-log tail (:523-553): each `@1h30m` attaches to the ref with the
  // greatest refLocation.End before it (else ret[0]); first log wins.
  const re = new RegExp(TIME_LOG_SOURCE, "gd");
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(content);
    if (m === null || m.indices === undefined || m.indices[1] === undefined) break;
    const [gs, ge] = m.indices[1];
    const entry = content.slice(gs + 1, ge); // the log without the @
    let f: RawReference | null = null;
    for (const ref of ret) {
      if (ref.refLocation !== null && ref.refLocation.end < gs && (f === null || (f.refLocation !== null && f.refLocation.end < ref.refLocation.end))) {
        f = ref;
      }
    }
    pos = m.index + m[0].length; // the whole-match end (the guard consumed)
    if (f === null) f = ret[0]!;
    if (f.timeLog === "") f.timeLog = entry;
  }

  return ret;
}

/** `FindAllIssueReferences` (:330-339) — the TITLE path: AppURL rewrite, no
 *  markdown strip, no links, no original content. */
export function findAllIssueReferences(content: string, options: ReferenceScanOptions): IssueReference[] {
  const pattern = giteaIssuePullPattern(options.appUrl);
  const rewritten = pattern === null ? content : convertFullHtmlReferencesToShortRefs(pattern, content);
  return findAllIssueReferencesBytes(rewritten, [], null, options).map(toIssueReference);
}

/**
 * `findAllIssueReferencesMarkdown` (:258-261) — the BODY path: strip + links,
 * the raw markdown rides as `originalContent` for the link keyword search.
 * The Raw twin returns the fixture-level shape (with locations).
 */
export function findAllIssueReferencesMarkdownRaw(content: string, options: ReferenceScanOptions): RawReference[] {
  const { text, links } = stripMarkdown(content, options.appUrl);
  return findAllIssueReferencesBytes(text, links, content, options);
}

export function findAllIssueReferencesMarkdown(content: string, options: ReferenceScanOptions): IssueReference[] {
  return findAllIssueReferencesMarkdownRaw(content, options).map(toIssueReference);
}

// ---------------------------------------------------------------------------
// The render-only members of the family (no xref rows — module header).
// ---------------------------------------------------------------------------

export interface RenderizableReference {
  issue: string;
  owner: string;
  name: string;
  commitSha: string;
  isPull: boolean;
  refLocation: RefSpan | null;
  action: RefActionValue;
  actionLocation: RefSpan | null;
}

/** `FindRenderizableCommitCrossReference` (:369-381). */
export function findRenderizableCommitCrossReference(content: string): RenderizableReference | null {
  const m = new RegExp(CROSS_REFERENCE_COMMIT_SOURCE, "d").exec(content);
  if (m === null || m.indices === undefined || m.indices[1] === undefined || m.indices[3] === undefined) return null;
  return {
    issue: "",
    owner: m[1]!,
    name: m[2]!,
    commitSha: m[3]!,
    isPull: false,
    refLocation: { start: m.indices[1][0], end: m.indices[3][1] },
    action: RefAction.None,
    actionLocation: null,
  };
}

/** `FindRenderizableReferenceAlphanumeric` (:415-429). */
export function findRenderizableReferenceAlphanumeric(content: string, keywords: KeywordPatterns = DEFAULT_KEYWORDS): RenderizableReference | null {
  const m = new RegExp(ISSUE_ALPHANUMERIC_SOURCE, "d").exec(content);
  if (m === null || m.indices === undefined || m.indices[1] === undefined) return null;
  const bytes = new ByteMap(content);
  const [gs, ge] = m.indices[1];
  const action = findActionKeywords(content, gs, bytes, keywords);
  return {
    issue: content.slice(gs, ge),
    owner: "",
    name: "",
    commitSha: "",
    isPull: false,
    refLocation: { start: bytes.byteAt(gs), end: bytes.byteAt(ge) },
    action: action.action,
    actionLocation: action.location,
  };
}

// ---------------------------------------------------------------------------
// The doer-side permission folds (verifyReferencedIssue's gates).
// ---------------------------------------------------------------------------

/** The doer identity the writer needs (a users row's projection). */
export interface XrefDoer {
  id: number;
  isAdmin: boolean;
}

const ACCESS_RANK: Record<string, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };

/**
 * `perm.CanReadIssuesOrPulls(refIssue.IsPull)` — the unit flag
 * (`repo_settings.has_issues`/`has_pull_requests`; a disabled unit is
 * unreadable to EVERYONE — api/services/issue-unit-gates.ts header) over the
 * landed access matrix (site admin / the repo's owner / a public repo / a
 * non-none `doerRepoAccessMode` grant — services/repository.ts's header and
 * services/mentions/resolve.ts:82-98's fold). A null doer reads the anonymous
 * posture: public repos only.
 */
export async function canReadIssuesOrPulls(d1: D1Database, repo: RepositoryRow, doer: XrefDoer | null, isPull: boolean): Promise<boolean> {
  const settings = await loadRepoSettings(d1, repo.id);
  if (!(isPull ? settings.hasPullRequests : settings.hasIssues)) return false;
  if (doer === null) return repo.visibility === "public";
  if (doer.isAdmin) return true;
  if (repo.ownerId !== null && doer.id === repo.ownerId) return true;
  if (repo.visibility === "public") return true;
  return (await doerRepoAccessMode(d1, repo, doer.id)) !== "none";
}

/** `perm.CanWriteIssuesOrPulls(refIssue.IsPull)` — AccessMode ≥ write. */
const WRITE_RANK = 2; // AccessMode "write" (access_mode.go:17-22)
export async function canWriteIssuesOrPulls(d1: D1Database, repo: RepositoryRow, doer: XrefDoer | null): Promise<boolean> {
  if (doer === null) return false;
  if (doer.isAdmin) return true;
  if (repo.ownerId !== null && doer.id === repo.ownerId) return true;
  return (ACCESS_RANK[await doerRepoAccessMode(d1, repo, doer.id)] ?? 0) >= WRITE_RANK;
}

// ---------------------------------------------------------------------------
// The writer (models/issues/issue_xref.go)
// ---------------------------------------------------------------------------

/** The referring issue's projection the scan needs (the post-write row). */
export interface XrefOriginIssue {
  id: number;
  repoId: string;
  isPull: boolean;
  title: string;
  content: string | null;
}

export interface SyncIssueCrossReferencesInput {
  origin: XrefOriginIssue;
  /** The acting user (the issue poster upstream); null rides the anonymous arms. */
  doerId: number | null;
  /** `AddCrossReferences(removeOld)` — true on every edit arm. */
  removeOld: boolean;
  /** The instance AppURL (request origin); "" = the nil-pattern arm. */
  appUrl: string;
  now: Date;
  /**
   * The COMMENT arm's presence marker (`crossReferencesContext.OrigComment`,
   * issue_xref.go:36): set when the origin is a comment — the scan then runs
   * over `origin.content` ALONE (upstream passes plaincontent="" and the
   * comment as mdcontent), rows are always type 5 carrying this id in
   * `ref_comment_id`, the remove-old fold keys on it, and the same-repo
   * merger exception of `verifyReferencedIssue` (:225-232) is disabled.
   * Callers go through `syncCommentCrossReferences`; this field is the
   * shared writer's internal seam.
   */
  originCommentId?: number | null;
}

/**
 * The COMMENT arm's input (`Comment.AddCrossReferences`, issue_xref.go:228-246):
 * the scan reads ONLY the comment's content, through the markdown entry.
 */
export interface SyncCommentCrossReferencesInput {
  /** The issue the comment sits on (the origin coordinates of every row). */
  issue: { id: number; repoId: string; isPull: boolean };
  /** The comment's id — the row's `ref_comment_id`. */
  commentId: number;
  /** The comment's content (the markdown-entry scan input — ("", c.Content)). */
  content: string;
  /** The acting user (the poster on create, the EDITOR on edit); null rides the anonymous arms. */
  doerId: number | null;
  /** `AddCrossReferences(removeOld)` — false on create, true on edit (comment.go:920/:1204). */
  removeOld: boolean;
  /** The instance AppURL (request origin); "" = the nil-pattern arm. */
  appUrl: string;
  now: Date;
}

/**
 * `Comment.AddCrossReferences` (issue_xref.go:228-246) — the comment arm
 * entry; the shared writer below is `createCrossReferences` (:77-134). The
 * HasContentSupport type gate (comment.go:180-186) is the CALLER's fold —
 * upstream applies it at this entry's head (:230-232), and callers here
 * reach it only for content-supporting types for the same reason.
 */
export function syncCommentCrossReferences(d1: D1Database, input: SyncCommentCrossReferencesInput): Promise<void> {
  return syncIssueCrossReferences(d1, {
    origin: { ...input.issue, title: "", content: input.content },
    doerId: input.doerId,
    removeOld: input.removeOld,
    appUrl: input.appUrl,
    now: input.now,
    originCommentId: input.commentId,
  });
}

/** The resolved target of one reference (the write list's entry). */
interface ResolvedXref {
  issueId: number;
  action: RefActionValue;
}

/**
 * `Issue.AddCrossReferences` (issue_xref.go:60-75) / `Comment.AddCrossReferences`
 * (:228-246) + the shared `createCrossReferences` (:77-134): scan the title
 * (non-markdown entry) and body (markdown entry) — or the comment content
 * alone through the markdown entry when `originCommentId` is set — resolve
 * the targets, fold the remove-old neuter/keep pair, and write one type-3
 * (issue origin) / type-6 (PR origin) / type-5 (comment origin) row ON THE
 * REFERENCED issue carrying `ref_repo_id`/`ref_issue_id`/`ref_comment_id`/
 * `ref_action`/`ref_is_pull` of the ORIGIN. The referenced issue's
 * num_comments (this repo's counts-system-comments convention) and
 * updated_unix move with each row. Errors propagate — upstream fails the
 * surrounding write the same way; the landed committed-prefix posture of the
 * non-transactional create/edit batches applies on top.
 */
export async function syncIssueCrossReferences(d1: D1Database, input: SyncIssueCrossReferencesInput): Promise<void> {
  const options: ReferenceScanOptions = { appUrl: input.appUrl };
  const commentOriginId: number | null = input.originCommentId ?? null;
  const commentArm = commentOriginId !== null;
  // The comment arm scans ("", c.Content) — plaincontent empty, the comment
  // through the markdown entry; the title/plain entries never run there.
  const refs = commentArm
    ? findAllIssueReferencesMarkdown(input.origin.content ?? "", options)
    : [
        ...findAllIssueReferences(input.origin.title, options),
        ...findAllIssueReferencesMarkdown(input.origin.content ?? "", options),
      ];
  const doer = input.doerId === null ? null : await loadDoer(d1, input.doerId);
  const resolved = await resolveCrossReferences(d1, input.origin, doer, refs, commentArm);

  const database = drizzle(d1);
  const statements: BatchStatement[] = [];

  if (input.removeOld) {
    // findOldCrossReferences (:35-41): the origin's LIVE rows — ref_action in
    // (none, closes, reopens), ref_issue_id = the origin, ref_comment_id
    // unset for title/body refs (our NULL ≡ upstream's 0) or the origin
    // comment's id for comment refs.
    const old = await database
      .select({ id: comments.id, issueId: comments.issueId, refAction: comments.refAction })
      .from(comments)
      .where(
        and(
          eq(comments.refIssueId, input.origin.id),
          commentOriginId !== null ? eq(comments.refCommentId, commentOriginId) : isNull(comments.refCommentId),
          inArray(comments.refAction, [RefAction.None, RefAction.Closes, RefAction.Reopens]),
        ),
      )
      .all();
    const neutered: number[] = [];
    const fresh = [...resolved];
    for (const row of old) {
      // The keep fold (:94-102): a row whose (target, action) pair the fresh
      // list still reproduces is KEPT and that fresh entry is consumed — no
      // duplicate row is written for it.
      const i = fresh.findIndex((x) => x.issueId === row.issueId && x.action === (row.refAction ?? RefAction.None));
      if (i >= 0) fresh.splice(i, 1);
      else neutered.push(row.id);
    }
    if (neutered.length > 0) {
      // neuterCrossReferencesIDs (:55-58): ONLY the ref_action column moves.
      statements.push(
        database.update(comments).set({ refAction: RefAction.Neutered }).where(inArray(comments.id, neutered)),
      );
    }
    for (const entry of fresh) statements.push(...writeStatements(database, input, entry));
  } else {
    for (const entry of resolved) statements.push(...writeStatements(database, input, entry));
  }

  const [first, ...rest] = statements;
  if (first !== undefined) {
    await database.batch([first, ...rest]);
  }
}

/** The row + counter statements for one fresh reference (:110-123). */
function writeStatements(
  database: DrizzleD1Database,
  input: SyncIssueCrossReferencesInput,
  entry: ResolvedXref,
): BatchStatement[] {
  const commentOriginId: number | null = input.originCommentId ?? null;
  return [
    database.insert(comments).values({
      // Comment origins always write CommentTypeCommentRef (5) — issue_xref.go
      // :36/:240 — regardless of whether the commented issue is a pull.
      type: commentOriginId !== null ? CommentType.CommentRef : input.origin.isPull ? CommentType.PullRef : CommentType.IssueRef,
      posterId: input.doerId ?? null,
      issueId: entry.issueId,
      content: "",
      refRepoId: input.origin.repoId,
      refIssueId: input.origin.id,
      refCommentId: commentOriginId,
      refAction: entry.action,
      refIsPull: input.origin.isPull,
      createdAt: input.now,
      updatedAt: input.now,
    }),
    // updateCommentInfos (:927-957): updated_unix moves for every comment
    // type; num_comments follows THIS repo's counts-system-comments
    // convention (module header — upstream counts Comment+Review only).
    database
      .update(issues)
      .set({ numComments: sql`num_comments + 1`, updatedAt: input.now })
      .where(eq(issues.id, entry.issueId)),
  ];
}

async function loadDoer(d1: D1Database, doerId: number): Promise<XrefDoer | null> {
  const row = await drizzle(d1)
    .select({ id: users.id, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, doerId))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/**
 * `getCrossReferences` (:136-176) + `verifyReferencedIssue` (:193-247) +
 * `updateCrossReferenceList` (:178-190): resolve every raw reference to a
 * target issue, upstream's gates in upstream's order —
 *   1. same-repo references take the origin's own repo; owner/name repos
 *      resolve by path, a miss SKIPS the reference silently (:150-155);
 *   2. the target issue must exist by (repo, index) (:198-202);
 *   3. close/reopen actions only FROM pull requests, reopen only TO issues
 *      (:205-207);
 *   4. the external-tracker arm (:213-215) has no counterpart here (no
 *      external-tracker unit in our schema — module header);
 *   5. the permission block runs whenever the target is cross-repo OR the
 *      raw action is actionable (:209-244): an unreadable target or a
 *      doer-blocked-by-target-poster/owner DROPS the row; an actionable raw
 *      reference from a doer who is neither the target's poster nor a writer
 *      of the target repo demotes to None when cross-repo — or when the
 *      origin is a COMMENT (`|| ctx.OrigComment != nil`, :225-232: the
 *      same-repo merger exception is a title/body-only privilege, a comment
 *      origin must hold the write or the poster to keep a close action);
 *   6. self-references never enter the list and duplicates fold to one entry,
 *      a later non-None action upgrading the fold (:178-190).
 */
async function resolveCrossReferences(
  d1: D1Database,
  origin: XrefOriginIssue,
  doer: XrefDoer | null,
  refs: IssueReference[],
  commentArm: boolean,
): Promise<ResolvedXref[]> {
  const database = drizzle(d1);
  const list: ResolvedXref[] = [];

  let originRepo: RepositoryWithOwner | null = null;
  const loadOriginRepo = async (): Promise<RepositoryWithOwner | null> => {
    if (originRepo === null) originRepo = await findRepositoryById(d1, origin.repoId);
    return originRepo;
  };

  for (const ref of refs) {
    let repoPair: RepositoryWithOwner | null;
    if (ref.owner === "" && ref.name === "") {
      repoPair = await loadOriginRepo();
      if (repoPair === null) continue; // cannot happen through healthy writes
    } else {
      repoPair = await findRepositoryByPath(d1, ref.owner, ref.name);
      if (repoPair === null) continue; // ErrRepoNotExist → skip (:151-154)
    }

    const refIssue = await database
      .select({ id: issues.id, repoId: issues.repoId, isPull: issues.isPull, posterId: issues.posterId })
      .from(issues)
      .where(and(eq(issues.repoId, repoPair.repo.id), eq(issues.index, ref.index)))
      .limit(1)
      .then((rows) => rows[0]);
    if (refIssue === undefined) continue; // the target does not exist (:198-202)

    let refAction = ref.action;
    // Close/reopen actions can only be set from pull requests; reopen only
    // to issues (:205-207).
    if (!origin.isPull || (refIssue.isPull && refAction === RefAction.Reopens)) {
      refAction = RefAction.None;
    }

    if (refIssue.repoId !== origin.repoId || ref.action !== RefAction.None) {
      const canRead = await canReadIssuesOrPulls(d1, repoPair.repo, doer, refIssue.isPull);
      if (!canRead) continue; // the row is dropped entirely (:217-220)
      // IsUserBlockedBy(doer, refIssue.PosterID, refIssue.Repo.OwnerID)
      // (:221-224) — the blocker list verbatim (nulls cannot occur upstream).
      const blockerIds = [refIssue.posterId ?? undefined, repoPair.repo.ownerId ?? undefined].filter(
        (id): id is number => id !== undefined,
      );
      if (doer !== null && (await isUserBlockedBy(d1, { id: doer.id, isAdmin: doer.isAdmin }, ...blockerIds))) {
        continue; // blocked-by drops the row
      }
      if (
        ref.action !== RefAction.None &&
        (doer === null || refIssue.posterId === null || doer.id !== refIssue.posterId) &&
        !(await canWriteIssuesOrPulls(d1, repoPair.repo, doer)) &&
        (refIssue.repoId !== origin.repoId || commentArm)
        // (:225-232) `refIssue.RepoID != ctx.OrigIssue.RepoID || ctx.OrigComment != nil`:
        // the merger exception is title/body-only — a comment origin keeps a
        // close action only through the poster or a write grant.
      ) {
        refAction = RefAction.None;
      }
    }

    // updateCrossReferenceList (:178-190): self-references drop; duplicates
    // fold, a later non-None action upgrades.
    if (refIssue.id === origin.id) continue;
    const existing = list.find((x) => x.issueId === refIssue.id);
    if (existing !== undefined) {
      if (refAction !== RefAction.None) existing.action = refAction;
      continue;
    }
    list.push({ issueId: refIssue.id, action: refAction });
  }

  return list;
}

// ---------------------------------------------------------------------------
// The reader-side arms this lane completes (the census row's reader cites).
// ---------------------------------------------------------------------------

/** `CommentTypeIsRef` (issue_xref.go:283-285) — the xref row types 3/5/6. */
export function commentTypeIsRef(type: number): boolean {
  return type === CommentType.CommentRef || type === CommentType.PullRef || type === CommentType.IssueRef;
}

/** The comment projection `isXRefCommentAccessible` needs. */
export interface XrefCommentProbe {
  type: number;
  refRepoId: string | null;
  refIsPull: boolean;
}

/**
 * `isXRefCommentAccessible` (routers/api/v1/repo/issue_comment.go:205-222):
 * a ref-type row whose origin repo differs from the timeline's repo is
 * dropped when the origin repo is gone or the VIEWER cannot read its
 * issue/pull unit there (the unit flag + the landed repo-read predicate —
 * `canViewRepositoryWithTeams`, the same gate `requireVisibleRepo` applies).
 */
export async function isXRefCommentAccessible(d1: D1Database, viewer: Viewer, comment: XrefCommentProbe, issueRepoId: string): Promise<boolean> {
  if (!commentTypeIsRef(comment.type)) return true;
  if (comment.refRepoId === null || comment.refRepoId === issueRepoId) return true;
  const refRepo = await findRepositoryById(d1, comment.refRepoId);
  if (refRepo === null) return false;
  if (!(await canViewRepositoryWithTeams(d1, viewer, refRepo.repo))) return false;
  const settings = await loadRepoSettings(d1, refRepo.repo.id);
  return comment.refIsPull ? settings.hasPullRequests : settings.hasIssues;
}
