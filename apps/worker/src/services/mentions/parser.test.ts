/**
 * The @mentions parser's fixtures.
 *
 * Rows 1:1 from the pin (fc493688): `TestRegExp_mentionPattern`
 * (gitea/modules/references/references_test.go:429-484 — the 23 true + 14
 * false pattern cases, asserted against the FIRST match's group-1 capture
 * exactly like upstream's FindStringSubmatch(found[1]) /
 * MatchString(false)) and `TestFindAllMentions` (:358-367 — the exact
 * RefSpans of "@tasha, @mike; @lucy: @john").
 *
 * The markdown-strip arms are DERIVED (cite-marked): upstream has no
 * FindAllMentionsMarkdown unit fixtures at the pin — the strip's exclusion
 * semantics (code fences, indented code, code spans, link text, linkified
 * URLs, raw HTML; image alt kept) are mdstripper's observable walk
 * (gitea/modules/markup/mdstripper/mdstripper.go:41-67 + the goldmark AST
 * shape), pinned here so the markdown-it re-replication cannot drift.
 */

import { describe, expect, it } from "vitest";

import { findAllMentions, findAllMentionsMarkdown, findFirstMention } from "./parser";

/** The first capture including the @ prefix — upstream `found[1]`. */
function firstMention(content: string): string | null {
  const span = findFirstMention(content);
  return span === null ? null : content.slice(span.start, span.end);
}

describe("mentionPattern — TestRegExp_mentionPattern true cases (references_test.go:430-458)", () => {
  const trueTestCases: Array<[string, string]> = [
    ["@User", "@User"],
    ["@ANT_123", "@ANT_123"],
    ["@xxx-DiN0-z-A..uru..s-xxx", "@xxx-DiN0-z-A..uru..s-xxx"],
    ["   @lol   ", "@lol"],
    [" @Te-st", "@Te-st"],
    ["(@gitea)", "@gitea"],
    ["[@gitea]", "@gitea"],
    ["@gitea! this", "@gitea"],
    ["@gitea? this", "@gitea"],
    ["@gitea. this", "@gitea"],
    ["@gitea, this", "@gitea"],
    ["@gitea; this", "@gitea"],
    ["@gitea!\nthis", "@gitea"],
    ["\n@gitea?\nthis", "@gitea"],
    ["\t@gitea.\nthis", "@gitea"],
    ["@gitea,\nthis", "@gitea"],
    ["@gitea;\nthis", "@gitea"],
    ["@gitea!", "@gitea"],
    ["@gitea?", "@gitea"],
    ["@gitea.", "@gitea"],
    ["@gitea,", "@gitea"],
    ["@gitea;", "@gitea"],
    ["@gitea/team1;", "@gitea/team1"],
    ["@user's idea", "@user"],
  ];

  for (const [input, expected] of trueTestCases) {
    it(`matches ${JSON.stringify(input)} → ${expected}`, () => {
      expect(firstMention(input)).toBe(expected);
    });
  }
});

describe("mentionPattern — TestRegExp_mentionPattern false cases (references_test.go:459-474)", () => {
  const falseTestCases = [
    "@ 0",
    "@ ",
    "@",
    "",
    "ABC",
    "@.ABC",
    "/home/gitea/@gitea",
    '"@gitea"',
    "@@gitea",
    "@gitea!this",
    "@gitea?this",
    "@gitea,this",
    "@gitea;this",
    "@gitea/team1/more",
  ];

  for (const input of falseTestCases) {
    it(`does not match ${JSON.stringify(input)}`, () => {
      expect(firstMention(input)).toBeNull();
    });
  }
});

describe("findAllMentions — TestFindAllMentions (references_test.go:358-367)", () => {
  it("locates every mention span in the upstream fixture line", () => {
    expect(findAllMentions("@tasha, @mike; @lucy: @john")).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 13 },
      { start: 15, end: 20 },
      { start: 22, end: 27 },
    ]);
  });

  it("keeps repeated mentions as separate spans — dedupe is the resolver's job (issue_update.go:583-611)", () => {
    expect(findAllMentions("@a @a")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe("findAllMentionsMarkdown — the mdstripper walk (derived arms, see the module header)", () => {
  it("basic: extracts names without the @ prefix, source case kept — folding happens at resolution (issue_update.go:597)", () => {
    expect(findAllMentionsMarkdown("hi @alice and @bob!")).toEqual(["alice", "bob"]);
    expect(findAllMentionsMarkdown("cc @Alice.Springs, @Bob_99;")).toEqual(["Alice.Springs", "Bob_99"]);
  });

  it("team mentions survive the markdown path (the @org/team alternative, references.go:33)", () => {
    expect(findAllMentionsMarkdown("ping @acme/devs please")).toEqual(["acme/devs"]);
  });

  it("fenced code blocks are excluded — goldmark code blocks carry no Text children", () => {
    expect(findAllMentionsMarkdown("```\n@fenced\n```\nafter @outside")).toEqual(["outside"]);
    expect(findAllMentionsMarkdown("~~~\n@tilde\n~~~\n@after")).toEqual(["after"]);
  });

  it("indented code blocks are excluded", () => {
    expect(findAllMentionsMarkdown("para\n\n    @indented\n\ntail @after")).toEqual(["after"]);
  });

  it("inline code spans are excluded — goldmark marks their text raw", () => {
    expect(findAllMentionsMarkdown("run `@incode` then @out")).toEqual(["out"]);
  });

  it("link text is excluded — ast.Link walks WalkSkipChildren (mdstripper.go:58-60)", () => {
    expect(findAllMentionsMarkdown("[@linktext](https://ex.com/@urluser) plus @real")).toEqual(["real"]);
  });

  it("emails are excluded — the lead guard: a word char before @ kills the match; autolink addresses ride the link skip", () => {
    expect(findAllMentionsMarkdown("mail user@example.com or <mailto:b@c.dev> then @user")).toEqual(["user"]);
  });

  it("linkified bare URLs are excluded (the Linkify extension → autolink shape)", () => {
    expect(findAllMentionsMarkdown("see https://ex.com/@who now @here")).toEqual(["here"]);
  });

  it("image alt text IS scanned — ast.Image is walked (no strip-renderer case)", () => {
    expect(findAllMentionsMarkdown("![pic @altuser](https://ex.com/x.png) and @main")).toEqual(["altuser", "main"]);
  });

  it("raw HTML tags drop out, the text between them survives (not Text nodes; the text after a raw span is a new run)", () => {
    expect(findAllMentionsMarkdown("hey <b>@bolded</b> and @plain")).toEqual(["bolded", "plain"]);
  });

  it("emphasis edges split runs like goldmark's AST siblings — '@us**er**' extracts 'us' (the coalesce rule's consequence)", () => {
    expect(findAllMentionsMarkdown("call @us**er**2 now")).toEqual(["us"]);
  });

  it("block structure (quotes, lists) keeps the inline text scannable", () => {
    expect(findAllMentionsMarkdown("> quote @quoted\n\n- list @item")).toEqual(["quoted", "item"]);
  });

  it("an unclosed fence swallows the trailing text — CommonMark forbids content after a closing fence, so '@yep' is INSIDE the block", () => {
    expect(findAllMentionsMarkdown("```\n@nope\n``` @yep")).toEqual([]);
    expect(findAllMentionsMarkdown("```\n@nope\n```\n@yep")).toEqual(["yep"]);
  });
});
