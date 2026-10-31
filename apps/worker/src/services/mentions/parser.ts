/**
 * The @mentions parser — the port of upstream's mention extraction at pin
 * fc493688. Upstream consolidated the old models/repo/mention.go into the
 * references package: the `mentionPattern` regexp, the `FindAllMentionsBytes`
 * scan and the `FindAllMentionsMarkdown` entry all live in
 * gitea/modules/references/references.go:32-250 at this pin (the
 * routers/web/shared/mention package is the autocomplete collector, NOT the
 * extraction path — it never runs the regexp).
 *
 * Three pieces, ported whole:
 *
 *   1. `mentionPattern` (references.go:33) — verbatim, with one mechanical
 *      translation: Go's `\s` is the ASCII class [\t\n\f\r ] while JS `\s`
 *      also eats Unicode spaces, so the class is spelled out to keep the
 *      languages' semantics identical (`\w` is the same ASCII class in both).
 *   2. `FindAllMentionsBytes` (references.go:219-240) — the iterative
 *      pos-advance scan. FindAllSubmatchIndex cannot be used (upstream's own
 *      comment: the pattern's lead/trailing \s guards make consecutive
 *      references share the space, so a global scan would eat the second
 *      mention's lead); the loop resumes at the END of each captured mention.
 *      The `spaceTrimmedPattern` notrail backoff (references.go:45, :232-237)
 *      is ported for structure but is dead for mentions by construction —
 *      the capture classes [-.\w] admit no \s, so the inner search can never
 *      match (upstream's identical situation; their notrail branch would
 *      index a group that the non-capturing pattern never produces — dead
 *      code there too, never taken).
 *   3. The markdown strip (`FindAllMentionsMarkdown`, references.go:207-215)
 *      — upstream runs the scan over `mdstripper.StripMarkdownBytes`
 *      (gitea/modules/markup/mdstripper/mdstripper.go:146-171): a goldmark
 *      parse walked by a renderer that emits ONLY non-raw ast.Text nodes
 *      (plus same-host issue-ref autolink rewrites, irrelevant here — the
 *      rewrite output `owner/repo#123` carries no `@`). Observable
 *      extraction semantics: fenced/indented code blocks have no Text
 *      children (excluded), code-span text is raw (excluded), link children
 *      are skipped — WalkSkipChildren on ast.Link AND ast.AutoLink, so link
 *      TEXT never reaches the scan (emails in `<mailto:...>` autolinks and
 *      linkify'd bare URLs die here), raw HTML nodes are not Text (the tags
 *      drop out, the text between html_inline boundaries stays), image alt
 *      text IS walked, soft/hard line breaks become "\n", and adjacent Text
 *      siblings COALESCE while a new inline container's first text child
 *      gets a "\n" separator (mdstripper's doubleSpace + the
 *      previous-sibling-is-Text coalesce check, mdstripper.go:41-67).
 *
 *      The strip here re-replicates those semantics over markdown-it (the
 *      landed markdown dependency — api/services/markdown.ts) because the
 *      tree-walk shape is identical: markdown-it's flat inline token list
 *      has open/close tokens exactly where goldmark has container edges, so
 *      "previous emitted chunk was text" == goldmark's
 *      previous-sibling-is-Text, and skipping everything between link_open
 *      and link_close == WalkSkipChildren. The strip instance parses with
 *      `html: true` (goldmark's strip parses raw HTML into dedicated nodes —
 *      mdstripper builds its goldmark with html.WithUnsafe) and `linkify:
 *      true` (the Linkify extension) — typographer off. The strip's output
 *      only feeds the regexp scanner; it is never rendered, so the html:true
 *      parse posture has no XSS surface. Fixture-pinned by parser.test.ts:
 *      upstream's two mention test rows 1:1 (references_test.go:358-367
 *      spans, :429-484 pattern matrix) plus cite-marked derived arms for the
 *      strip (upstream has no FindAllMentionsMarkdown unit fixtures at the
 *      pin — the only mention tests are those two).
 */

import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

/**
 * Upstream `mentionPattern` (references.go:33) — matches `@user` or
 * `@org/team`, group 1 = the mention INCLUDING the @ prefix. The lead and
 * trailing guard classes reject emails (the `@` must follow whitespace or an
 * opener) and glued punctuation (`@gitea!this` — `!` needs a space/end after).
 */
const MENTION_PATTERN_SOURCE =
  "(?:[\\t\\n\\f\\r ]|^|\\(|\\[)" + // (\s|^|\(|\[)
  "(@[-\\w][-.\\w]*?|@[-\\w][-.\\w]*?/[-\\w][-.\\w]*?)" + // group 1
  "(?:[\\t\\n\\f\\r ]|$|[:,;.?!]([\\t\\n\\f\\r ]|$)|'|\\)|\\])"; // (\s|$|[:,;.?!](\s|$)|'|\)|\])

/**
 * Upstream `spaceTrimmedPattern` (references.go:45) — the notrail backoff's
 * trailing-space probe (dead for mention captures; see the module header).
 */
const SPACE_TRIMMED_SOURCE = "(?:.*[0-9A-Za-z_-])[\\t\\n\\f\\r ]";

/** A located mention: the `@`-inclusive capture span (upstream `RefSpan`
 *  over the mention text, references.go:219's return shape). */
export interface MentionSpan {
  start: number;
  end: number;
}

/** `FindFirstMentionBytes` (references.go:244-250) — the first mention's
 *  span, or null. Single unanchored match, no global state. */
export function findFirstMention(content: string): MentionSpan | null {
  const match = new RegExp(MENTION_PATTERN_SOURCE, "d").exec(content);
  const span = match?.indices?.[1];
  if (span === undefined) return null;
  return { start: span[0], end: span[1] };
}

/** `FindAllMentionsBytes` (references.go:219-240) — the iterative scan; the
 *  scan resumes at the end of each capture so consecutive mentions sharing
 *  one space both land (the TestFindAllMentions fixture pins the exact
 *  spans on "@tasha, @mike; @lucy: @john"). */
export function findAllMentions(content: string): MentionSpan[] {
  const ret: MentionSpan[] = [];
  const re = new RegExp(MENTION_PATTERN_SOURCE, "gd");
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const match = re.exec(content);
    if (match === null) break;
    const group = match.indices?.[1];
    if (group === undefined) break;
    const start = group[0];
    const end = group[1];
    ret.push({ start, end });
    // The notrail backoff (references.go:232-237): upstream searches
    // spaceTrimmedPattern inside the capture and resumes past its tail.
    // Dead for mentions BY CONSTRUCTION — the capture classes [-.\w] admit
    // no \s, so the probe below can never match — and a nil match
    // degenerates to pos = end. Ported as the degenerate form with the
    // probe kept as the structured witness.
    const notrail = new RegExp(SPACE_TRIMMED_SOURCE).exec(content.slice(start, end));
    pos = notrail === null ? end : end;
  }
  return ret;
}

/**
 * The mdstripper's strip renderer as a token walk. Emits text chunks with
 * goldmark's whitespace discipline; the state machine's `prevWasText`
 * reproduces mdstripper's coalesce rule (mdstripper.go:43-46: a separator
 * "\n" precedes every text run UNLESS the previous sibling was also Text).
 * markdown-it's open/close tokens sit exactly at goldmark's container
 * edges, so the flat children list needs no parent tracking.
 */
function stripInlines(tokens: Token[], out: string[]): void {
  let prevWasText = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case "text":
      case "text_special": {
        // text_special (entities, hard breaks' residue) is plain content —
        // goldmark parses entities into adjacent Text nodes that coalesce.
        if (out.length > 0 && !prevWasText) out.push("\n");
        out.push(token.content);
        prevWasText = true;
        break;
      }
      case "softbreak":
      case "hardbreak": {
        // mdstripper: the SoftLineBreak flag double-spaces after the run
        // (mdstripper.go:47-49); the following Text still coalesces.
        if (out.length > 0) out.push("\n");
        prevWasText = true;
        break;
      }
      case "code_inline": {
        // Code-span text is raw in goldmark — never emitted.
        prevWasText = false;
        break;
      }
      case "html_inline": {
        // Raw HTML is not a Text node (mdstripper walks only ast.Text);
        // the text after a raw span is a new run.
        prevWasText = false;
        break;
      }
      case "link_open": {
        // ast.Link → WalkSkipChildren (mdstripper.go:58-60): the link's
        // whole subtree (text, nested images) drops out; linkify'd bare
        // URLs and autolinks take the same shape, so their text — email
        // addresses included — never reaches the scan.
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
        // ast.Image is walked (no case in the strip renderer →
        // WalkContinue): the alt text's inline children ARE emitted, as a
        // fresh run (the Image is not a Text sibling); whatever follows the
        // image starts a new run too.
        if (token.children !== null) {
          const inner: string[] = [];
          stripInlines(token.children, inner);
          out.push(...inner);
        }
        prevWasText = false;
        break;
      }
      default: {
        // strong/em/s/... open-close pairs and any other wrapper: container
        // edges — the text inside starts a new run, and so does the text
        // after (mdstripper.go:43-46 via the AST sibling rule).
        prevWasText = false;
        break;
      }
    }
  }
}

/**
 * `mdstripper.StripMarkdownBytes` over markdown-it (module header item 3):
 * the block walk drops fenced/indented code and HTML blocks wholesale (they
 * surface as `fence`/`code_block`/`html_block` tokens with no inline child —
 * goldmark's code blocks carry no Text children either), and each `inline`
 * token's children go through the strip walk. The join is "", not "\n" —
 * the separators are emitted by the walk itself, exactly like the renderer's
 * buffer.
 */
function stripMarkdownForScan(markdown: string): string {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  const out: string[] = [];
  for (const token of md.parse(markdown, {})) {
    if (token.type === "inline" && token.children !== null) {
      stripInlines(token.children, out);
    }
    // Everything else (fence, code_block, html_block, block/heading open-
    // close pairs) contributes no text — goldmark's walk sees none.
  }
  return out.join("");
}

/** `FindAllMentionsMarkdown` (references.go:207-215) — strip first, scan
 *  second, return the mention NAMES without the @ prefix. This is the
 *  upstream entry the write paths call (models/issues/issue_update.go:553). */
export function findAllMentionsMarkdown(content: string): string[] {
  const stripped = stripMarkdownForScan(content);
  return findAllMentions(stripped).map((span) => stripped.slice(span.start + 1, span.end));
}
