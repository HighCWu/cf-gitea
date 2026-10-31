/**
 * The export-subst expander's white-box pins (services/export-subst.ts): the
 * `$Format:…$` marker scan (multi-line markers, the unterminated `$` steal,
 * the EOF literal arm, binary safety), every honored placeholder class
 * rendered from one fixture commit, the subject/body split edges, the four
 * date modes in the commit's own offset, the mailmap forms, and the
 * decoration order. Every expected string was byte-verified against a real
 * `git archive` 2.43.0 run over equivalent fixture content (the parity
 * observation battery behind the residuals-v1.3.2 item-8 arm), so these pins
 * double as the git-parity record.
 */

import { describe, expect, it } from "vitest";

import {
  applyMailmap,
  buildDecorations,
  EMPTY_MAILMAP,
  expandExportSubst,
  parseMailmap,
  renderDate,
  renderFormat,
  splitMessage,
  type SubstContext,
} from "./export-subst";

const ENC = new TextEncoder();

const OID = "6220b1d0a9c43a797542375847a299ebfeb8b9cf";
const TREE = "4938ec6f5fab1c3b7a7ab9070af1f7aa13ea9838";
const PARENT = "a0f34c47b23d62afa69bbed2513f19ef971ddd5b";

/** git's byte-observed renderings for this identity pair (+0530 author, -0800 committer). */
const AUTHOR = { name: "Author Two", email: "author@example.com", time: 1_772_674_689, tz: "+0530" };
const COMMITTER = { name: "Committer One", email: "committer@example.com", time: 1_772_730_489, tz: "-0800" };
const MESSAGE = "attrs: probe markers\n";

function ctx(overrides?: Partial<SubstContext>): SubstContext {
  return {
    commit: { oid: OID, tree: TREE, parents: [PARENT], author: AUTHOR, committer: COMMITTER, message: MESSAGE },
    decorations: [],
    mailmap: EMPTY_MAILMAP,
    ...overrides,
  };
}

/** The byte-level pipeline: full `$Format:…$` marker scan + rendering. */
const expand = (text: string, context = ctx()): string =>
  new TextDecoder().decode(expandExportSubst(ENC.encode(text), context));

/** The renderer alone: a format string with no marker scanning. */
const render = (format: string, context = ctx()): string => renderFormat(format, context);

// ---------------------------------------------------------------------------
// The $Format:…$ marker scan (archive.c format_subst)
// ---------------------------------------------------------------------------

describe("export-subst marker scan", () => {
  it("expands a marker closed by the NEXT $ byte — the marker may span newlines (the multi-line marker)", () => {
    const decorated = ctx({ decorations: ["HEAD -> main", "tag: v1"] });
    expect(expand("line1\n$Format:%d\nsubject=%s$\nline-after\n", decorated)).toBe(
      "line1\n (HEAD -> main, tag: v1)\nsubject=attrs: probe markers\nline-after\n",
    );
  });

  it("expands a multi-line format: the newline in the format text renders literally", () => {
    expect(expand("A\n$Format:FIRST%nSECOND$\nB\n")).toBe("A\nFIRST\nSECOND\nB\n");
  });

  it("an unterminated $Format: steals the next $ in the file (byte-observed git posture)", () => {
    expect(expand("start $Format:%H middle $ between $Format:%h$ end\n$Format:%an\n")).toBe(
      `start ${OID} middle  between ${OID.slice(0, 7)} end\n$Format:%an\n`,
    );
  });

  it("an unterminated marker with NO further $ stays literal to EOF", () => {
    expect(expand("tail $Format:%ct")).toBe("tail $Format:%ct");
    expect(expand("tail $Format:%ct\n")).toBe("tail $Format:%ct\n");
  });

  it("an empty format expands to the empty string (marker removed)", () => {
    expect(expand("a $Format:$ b")).toBe("a  b");
  });

  it("markers are independent: literal text between two markers survives, $$ adjacency keeps outer dollars", () => {
    expect(expand(`$$Format:%H$$\n`)).toBe(`$${OID}$\n`);
    expect(expand(`$Format:%s$ also plain $Format:%h$\n`)).toBe(`attrs: probe markers also plain ${OID.slice(0, 7)}\n`);
  });

  it("binary content expands byte-exactly: NUL bytes and the marker's span only", () => {
    const raw = ENC.encode("A\u0000B\u0000$Format:%H$\u0000C\n");
    const out = expandExportSubst(raw, ctx());
    expect(new TextDecoder().decode(out)).toBe(`A\u0000B\u0000${OID}\u0000C\n`);
    expect(out.byteLength).toBe(raw.byteLength - "$Format:%H$".length + OID.length);
  });

  it("content without markers returns the same bytes object (no copy)", () => {
    const raw = ENC.encode("no marker here\n");
    expect(expandExportSubst(raw, ctx())).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Every honored placeholder class, from one fixture commit
// (expected values byte-verified against git 2.43.0's own archive output)
// ---------------------------------------------------------------------------

describe("placeholder classes (git 2.43.0 byte parity)", () => {
  it("expands the identity, hash and parent classes", () => {
    expect(render("%H")).toBe(OID);
    expect(render("%h")).toBe(OID.slice(0, 7));
    expect(render("%T")).toBe(TREE);
    expect(render("%t")).toBe(TREE.slice(0, 7));
    expect(render("%P")).toBe(PARENT);
    expect(render("%p")).toBe(PARENT.slice(0, 7));
  });

  it("expands the author/committer name+email classes (mailmap off = identity)", () => {
    expect(render("%an")).toBe("Author Two");
    expect(render("%ae")).toBe("author@example.com");
    expect(render("%aN")).toBe("Author Two");
    expect(render("%aE")).toBe("author@example.com");
    expect(render("%cn")).toBe("Committer One");
    expect(render("%ce")).toBe("committer@example.com");
    expect(render("%al")).toBe("author");
    expect(render("%aL")).toBe("author");
    expect(render("%cl")).toBe("committer");
    expect(render("%cL")).toBe("committer");
  });

  it("expands the date classes in the commit's OWN timezone offset", () => {
    expect(render("%ad")).toBe("Thu Mar 5 07:08:09 2026 +0530");
    expect(render("%aD")).toBe("Thu, 5 Mar 2026 07:08:09 +0530");
    expect(render("%aI")).toBe("2026-03-05T07:08:09+05:30");
    expect(render("%ai")).toBe("2026-03-05 07:08:09 +0530");
    expect(render("%at")).toBe("1772674689");
    expect(render("%cd")).toBe("Thu Mar 5 09:08:09 2026 -0800");
    expect(render("%cD")).toBe("Thu, 5 Mar 2026 09:08:09 -0800");
    expect(render("%cI")).toBe("2026-03-05T09:08:09-08:00");
    expect(render("%ci")).toBe("2026-03-05 09:08:09 -0800");
    expect(render("%ct")).toBe("1772730489");
  });

  it("expands the message classes: %s joins the wrapped subject, %f sanitizes the FIRST line only", () => {
    expect(render("%s")).toBe("attrs: probe markers");
    expect(render("%f")).toBe("attrs-probe-markers");
    expect(render("%b")).toBe("");
    expect(render("%B")).toBe(MESSAGE);
  });

  it("expands %d with the parens+space wrapper and %D bare; both empty without decorations", () => {
    const decorations = ["HEAD -> main", "tag: v1", "refs/pull/1/head", "feature/one"];
    const decorated = ctx({ decorations });
    expect(render("%d", decorated)).toBe(" (HEAD -> main, tag: v1, refs/pull/1/head, feature/one)");
    expect(render("%D", decorated)).toBe("HEAD -> main, tag: v1, refs/pull/1/head, feature/one");
    expect(render("%d")).toBe("");
    expect(render("%D")).toBe("");
  });

  it("expands the escapes and leaves EVERY unknown placeholder literal (git's unknown arm)", () => {
    expect(render("%%")).toBe("%");
    expect(render("%n")).toBe("\n");
    expect(expand("$Format:%ZZ$")).toBe("%ZZ");
    expect(expand("$Format:%Zn$")).toBe("%Zn"); // byte-observed: rescanned chars stay literal
    expect(expand("$Format:%x41$")).toBe("%x41");
    expect(expand("$Format:%ar$")).toBe("%ar");
    expect(expand("$Format:%e$")).toBe("%e");
    expect(expand("$Format:%N$")).toBe("%N");
    expect(expand("$Format:%m$")).toBe("%m");
    expect(expand("$Format:%G?$")).toBe("%G?");
    expect(expand("$Format:%Cred$")).toBe("%Cred");
    expect(expand("$Format:%w(30,1,2)%s$")).toBe("%w(30,1,2)attrs: probe markers");
    expect(expand("$Format:%(trailers)$")).toBe("%(trailers)");
  });

  it("a lone trailing % is literal", () => {
    expect(render("100%")).toBe("100%");
    expect(render("%")).toBe("%");
  });
});

// ---------------------------------------------------------------------------
// The subject/body split (pretty.c parse_commit_message + format_subject)
// ---------------------------------------------------------------------------

describe("subject/body split edges", () => {
  const splitCtx = (message: string): SubstContext => ctx({ commit: { ...ctx().commit, message } });

  it("joins wrapped subject lines with single spaces; the body runs to the end", () => {
    expect(splitMessage("this is\na wrapped subject\n\nbody first line\n\nmore body\n")).toEqual({
      subjectLines: ["this is", "a wrapped subject"],
      firstLine: "this is",
      body: "body first line\n\nmore body\n",
    });
    expect(render("%s", splitCtx("this is\na wrapped subject\n\nbody\n"))).toBe("this is a wrapped subject");
    expect(render("%b", splitCtx("this is\na wrapped subject\n\nbody\n"))).toBe("body\n");
    expect(render("%f", splitCtx("this is\na wrapped subject\n\nbody\n"))).toBe("this-is");
  });

  it("right-trims each subject line; leading spaces survive, trailing runs do not", () => {
    expect(render("%s", splitCtx("  spaced subject  \n\nbody\n"))).toBe("  spaced subject");
    expect(render("%f", splitCtx("  spaced subject  \n\nbody\n"))).toBe("spaced-subject");
  });

  it("skips leading blank lines for %s/%f/%b but keeps them in %B", () => {
    const message = "\n\n\nreal subject\n\nbody\n";
    expect(render("%s", splitCtx(message))).toBe("real subject");
    expect(render("%B", splitCtx(message))).toBe(message);
    expect(render("%b", splitCtx(message))).toBe("body\n");
  });

  it("a message without a blank line has an empty body; a bare message has no newline", () => {
    expect(render("%b", splitCtx("merge topic\ninto main\n"))).toBe("");
    expect(render("%B", splitCtx("merge topic\ninto main\n"))).toBe("merge topic\ninto main\n");
    expect(render("%s", splitCtx("bare"))).toBe("bare");
    expect(render("%b", splitCtx("bare"))).toBe("");
  });

  it("%f sanitizes like format_sanitized_subject: runs collapse, dots fold, trailing .- trim, no leading dash", () => {
    expect(render("%f", splitCtx("Fix  the (buggy)   thing...\n"))).toBe("Fix-the-buggy-thing");
    expect(render("%f", splitCtx("...leading dots\n"))).toBe(".leading-dots");
    expect(render("%f", splitCtx("under_score.and.dots\n"))).toBe("under_score.and.dots");
    expect(render("%f", splitCtx("trailing dash-\n"))).toBe("trailing-dash");
    // byte-observed git run over a literal backslash-t subject; real tabs are
    // plain non-title bytes — the trailing run adds nothing
    expect(render("%f", splitCtx("\\t tabby subject \\t\n"))).toBe("t-tabby-subject-t");
    expect(render("%f", splitCtx("\t tabby subject \t\n"))).toBe("tabby-subject");
    expect(render("%f", splitCtx("///\n"))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Dates (date.c show_date's archive modes)
// ---------------------------------------------------------------------------

describe("date rendering modes", () => {
  it("renders the four formats in the commit's own offset (git 2.43 byte parity)", () => {
    expect(renderDate(1_772_674_689, "+0530", "normal")).toBe("Thu Mar 5 07:08:09 2026 +0530");
    expect(renderDate(1_772_674_689, "+0530", "rfc2822")).toBe("Thu, 5 Mar 2026 07:08:09 +0530");
    expect(renderDate(1_772_674_689, "+0530", "iso8601")).toBe("2026-03-05 07:08:09 +0530");
    expect(renderDate(1_772_674_689, "+0530", "iso8601-strict")).toBe("2026-03-05T07:08:09+05:30");
    expect(renderDate(1_772_674_689, "+0530", "unix")).toBe("1772674689");
    expect(renderDate(1_772_730_489, "-0800", "normal")).toBe("Thu Mar 5 09:08:09 2026 -0800");
    expect(renderDate(1_772_730_489, "-0800", "iso8601-strict")).toBe("2026-03-05T09:08:09-08:00");
    expect(renderDate(1_800_000_000, "+0000", "normal")).toBe("Fri Jan 15 08:00:00 2027 +0000");
  });

  it("days are never zero-padded in normal/rfc2822 (git's %d), always in ISO modes", () => {
    expect(renderDate(1_743_724_800, "+0000", "normal")).toBe("Fri Apr 4 00:00:00 2025 +0000");
    expect(renderDate(1_743_724_800, "+0000", "rfc2822")).toBe("Fri, 4 Apr 2025 00:00:00 +0000");
    expect(renderDate(1_743_724_800, "+0000", "iso8601")).toBe("2025-04-04 00:00:00 +0000");
  });
});

// ---------------------------------------------------------------------------
// Mailmap (mailmap.c parse + map_user — the bare HEAD:.mailmap posture)
// ---------------------------------------------------------------------------

describe("mailmap", () => {
  const MAILMAP = [
    "# comment line",
    "Proper Person <proper@example.com>",
    "",
    "Proper Person <proper@example.com> <test@example.com>",
    "Only Email <only@example.com> <other@example.com>",
    "<swap@example.com> <oldswap@example.com>",
    "Weird Name <weird@example.com> Weird <weird@example.com>",
    "",
  ].join("\n");
  const map = parseMailmap(MAILMAP);

  it("rewrites name and email for the two-pair form (git 2.43 byte parity)", () => {
    expect(applyMailmap(map, { name: "Test User", email: "test@example.com" })).toEqual({
      name: "Proper Person",
      email: "proper@example.com",
    });
  });

  it("the email-only form rewrites the email and keeps the commit name", () => {
    expect(applyMailmap(map, { name: "Some Body", email: "other@example.com" })).toEqual({
      name: "Only Email",
      email: "only@example.com",
    });
  });

  it("the single-pair form rewrites the name only, keyed on its own email", () => {
    expect(applyMailmap(map, { name: "Whomever", email: "proper@example.com" }).name).toBe("Proper Person");
    expect(applyMailmap(map, { name: "Whomever", email: "proper@example.com" }).email).toBe("proper@example.com");
  });

  it("the swap form replaces only the email", () => {
    expect(applyMailmap(map, { name: "Whomever", email: "oldswap@example.com" })).toEqual({
      name: "Whomever",
      email: "swap@example.com",
    });
  });

  it("both lookups are case-insensitive (map->cmp = namemap_cmp)", () => {
    expect(applyMailmap(map, { name: "Test User", email: "TEST@EXAMPLE.COM" })).toEqual({
      name: "Proper Person",
      email: "proper@example.com",
    });
    expect(applyMailmap(map, { name: "WEIRD", email: "weird@example.com" })).toEqual({
      name: "Weird Name",
      email: "weird@example.com",
    });
  });

  it("a name-scoped entry falls back to the simple arm on a name miss", () => {
    expect(applyMailmap(map, { name: "Nobody", email: "weird@example.com" })).toEqual({
      name: "Nobody",
      email: "weird@example.com",
    });
  });

  it("unmapped identities pass through unchanged", () => {
    const person = { name: "Test User", email: "unlisted@example.com" };
    expect(applyMailmap(map, person)).toBe(person);
  });

  it("comments, blank lines, and bracket-less lines parse out; the last line for an email wins", () => {
    const m = parseMailmap("# not an entry\n\nnot a pair\nFirst <a@e>\nSecond <b@e> <a@e>\n");
    expect(applyMailmap(m, { name: "x", email: "a@e" })).toEqual({ name: "Second", email: "b@e" });
    expect(applyMailmap(m, { name: "x", email: "unmapped@e" })).toEqual({ name: "x", email: "unmapped@e" });
  });

  it("an empty map is the identity", () => {
    expect(applyMailmap(EMPTY_MAILMAP, { name: "A", email: "a@e" })).toEqual({ name: "A", email: "a@e" });
    expect(render("%aN", ctx({ mailmap: EMPTY_MAILMAP }))).toBe("Author Two");
  });
});

// ---------------------------------------------------------------------------
// Decorations (log-tree.c load_ref_decorations + format_decorations)
// ---------------------------------------------------------------------------

describe("decorations", () => {
  const MERGE = "285177fc1f732fcabaf87f4bedbe036dbddb1ae6";
  const HEAD = "5a8cbd6b407df4a23abc01aabf94bd5e5dbf9fd3";
  const SIDECOMMIT = "735f3c5bbd24151a3277f51299023e134783166a";
  const REFS = [
    { name: "refs/heads/aaa", target: MERGE },
    { name: "refs/heads/main", target: HEAD },
    { name: "refs/heads/side", target: SIDECOMMIT },
    { name: "refs/tags/ann2", target: "532e79b50f73b856203000e308e520902a0a9e3d", peeled: MERGE },
    { name: "refs/tags/v2", target: MERGE },
  ];

  it("HEAD first with the pointer arrow consuming the branch item; the rest reverse byte-order (git 2.43 parity)", () => {
    expect(buildDecorations(REFS, "refs/heads/main", HEAD)).toEqual(["HEAD -> main"]);
    expect(buildDecorations(REFS, "refs/heads/main", MERGE)).toEqual(["tag: v2", "tag: ann2", "aaa"]);
    expect(buildDecorations(REFS, "refs/heads/main", SIDECOMMIT)).toEqual(["side"]);
  });

  it("annotated tags decorate their PEELED commit with the tag: prefix", () => {
    // ann2's target is the tag object; only the peeled oid reaches the commit
    expect(buildDecorations(REFS, null, MERGE)).toEqual(["tag: v2", "tag: ann2", "aaa"]);
  });

  it("non-head/tag refs render their FULL name (prettify strips only heads/tags/remotes)", () => {
    const refs = [
      { name: "refs/custom/z", target: HEAD },
      { name: "refs/heads/main", target: HEAD },
      { name: "refs/pull/7/head", target: HEAD },
    ];
    expect(buildDecorations(refs, "refs/heads/main", HEAD)).toEqual(["HEAD -> main", "refs/pull/7/head", "refs/custom/z"]);
    expect(buildDecorations(refs, null, HEAD)).toEqual(["refs/pull/7/head", "main", "refs/custom/z"]);
  });

  it("an empty ref list renders empty decorations", () => {
    expect(buildDecorations([], "refs/heads/main", HEAD)).toEqual([]);
  });

  it("%d wraps the joined items in ' ()', %D does not", () => {
    const decorated = ctx({ decorations: buildDecorations(REFS, "refs/heads/main", MERGE) });
    expect(render("%d", decorated)).toBe(" (tag: v2, tag: ann2, aaa)");
    expect(render("%D", decorated)).toBe("tag: v2, tag: ann2, aaa");
  });
});
