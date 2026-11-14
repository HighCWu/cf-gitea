/**
 * CODEOWNERS parser + matcher (census B-53 — services/codeowners.ts over
 * real D1): the tokenizer table ported from upstream's own battery
 * (models/issues/pull_test.go testParseCodeOwnersLine), the absolute-path
 * pattern semantics (testCodeOwnerAbsolutePathPatterns), the owner
 * resolution over seeded users/teams (the GetUserByName lower_name
 * type-blind arm, the GetOrgByName + display-case team arm, every upstream
 * warning text), the content parser's line-number warnings, the
 * rules×files matcher with the negative-rule inversion and the aggregate
 * budget's `complete` flag, and the discovery read's precedence /
 * fail-closed / miss arms over a scripted readBlob.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { matchCodeOwnerRules, parseCodeOwners, parseCodeOwnersLine, tokenizeCodeOwnersLine, discoverCodeOwnerRules, MAX_CODEOWNERS_BYTES } from "./codeowners";
import { teams, teamMembers } from "../db/schema";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => drizzle(env.DB);

beforeEach(async () => {
  for (const table of ["team_members", "teams", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The fixture owners: 1 = alice (a plain user), 2 = bob, 5 = the org row,
  // 6/7 = org members.
  for (const [id, username] of [
    [1, "alice"],
    [2, "bob"],
    [5, "launch-org"],
    [6, "mia"],
    [7, "noah"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, 0, 'active', 'user', 0)",
    )
      .bind(id, username, username)
      .run();
  }
  await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = 5").run();
  const teamRows = await db()
    .insert(teams)
    .values([
      { id: 101, orgId: 5, lowerName: "backend", name: "Backend", authorize: "write" },
      { id: 102, orgId: 5, lowerName: "frontend", name: "Frontend", authorize: "write" },
    ])
    .returning({ id: teams.id })
    .all();
  await db().insert(teamMembers).values([
    { orgId: 5, teamId: teamRows[0]!.id, userId: 6 },
    { orgId: 5, teamId: teamRows[1]!.id, userId: 7 },
  ]);
});

// ---------------------------------------------------------------------------
// The tokenizer (models/issues/pull.go:947-982; pull_test.go's
// testParseCodeOwnersLine table verbatim — the Go backtick literals are the
// JS literals here).
// ---------------------------------------------------------------------------

describe("tokenizeCodeOwnersLine (pull_test.go testParseCodeOwnersLine)", () => {
  // The Go backtick literals verbatim — String.raw keeps the doubled
  // backslashes the Go source shows (the tokenizer resolves `\\`→`\` and
  // `\X`→`X`, so a pattern token carrying `\.` needs `\\.` in the file).
  const cases: [string, string[]][] = [
    { Line: "", Tokens: [] },
    { Line: "# comment", Tokens: [] },
    { Line: "!.* @user1 @org1/team1", Tokens: ["!.*", "@user1", "@org1/team1"] },
    { Line: String.raw`.*\\.js @user2 #comment`, Tokens: [String.raw`.*\.js`, "@user2"] },
    {
      Line: String.raw`docs/(aws|google|azure)/[^/]*\\.(md|txt) @org3 @org2/team2`,
      Tokens: [String.raw`docs/(aws|google|azure)/[^/]*\.(md|txt)`, "@org3", "@org2/team2"],
    },
    { Line: String.raw`\#path @org3`, Tokens: ["#path", "@org3"] },
    { Line: String.raw`path\ with\ spaces/ @org3`, Tokens: [String.raw`path with spaces/`, "@org3"] },
    { Line: String.raw`/docs/.*\\.md @user1`, Tokens: [String.raw`/docs/.*\.md`, "@user1"] },
    { Line: String.raw`!/assets/.*\\.(bin|exe|msi) @user1`, Tokens: [String.raw`!/assets/.*\.(bin|exe|msi)`, "@user1"] },
  ].map((g) => [g.Line, g.Tokens]);

  for (const [line, expected] of cases) {
    it(`tokenizes ${JSON.stringify(line)}`, () => {
      expect(tokenizeCodeOwnersLine(line)).toEqual(expected);
    });
  }

  it("treats tabs as separators and collapses runs of spaces (:953)", () => {
    expect(tokenizeCodeOwnersLine("\ta.md\t@u\t\t@v")).toEqual(["a.md", "@u", "@v"]);
    expect(tokenizeCodeOwnersLine("a.md    @u")).toEqual(["a.md", "@u"]);
  });

  it("keeps a trailing lone escape's partial token (:977-980)", () => {
    expect(tokenizeCodeOwnersLine("a.md\\ @u")).toEqual(["a.md @u"]);
  });
});

// ---------------------------------------------------------------------------
// The pattern semantics (testCodeOwnerAbsolutePathPatterns) + the compile
// and safety-screen arms.
// ---------------------------------------------------------------------------

describe("ParseCodeOwnersLine — the pattern arms (:876-911)", () => {
  it.each([
    { content: "/README.md @alice", file: "README.md", expected: true },
    { content: "/docs/.* @alice", file: "docs/foo.md", expected: true },
    { content: "/docs/.* @alice", file: "other/docs/foo.md", expected: false },
    { content: "README.md @alice", file: "README.md", expected: true },
    { content: "!/.* @alice", file: "README.md", expected: false },
  ])("absolute-path semantics: $content vs $file → $expected", async ({ content, file, expected }) => {
    const { rules } = await parseCodeOwners(env.DB, content + "\n");
    expect(rules.length).toBe(1);
    const rule = rules[0]!;
    // :136-141 — matched != rule.Negative is the rule's predicate.
    expect(rule.regexp.test(file) !== rule.negative).toBe(expected);
  });

  it("compiles the regex family — groups, classes, escapes (the .NET-family language)", async () => {
    const { rules, warnings } = await parseCodeOwners(env.DB, String.raw`docs/(aws|google|azure)/[^/]*\\.(md|txt) @alice` + "\n");
    expect(warnings).toEqual([]);
    expect(rules[0]!.regexp.test("docs/aws/keep.md")).toBe(true);
    expect(rules[0]!.regexp.test("docs/aws/keep.txt")).toBe(true);
    expect(rules[0]!.regexp.test("docs/aws/sub/keep.md")).toBe(false);
    expect(rules[0]!.regexp.test("docs/gcp/keep.md")).toBe(false);
  });

  it("\\p{...} property classes match like regexp2's (the u-mode compile, census B-53 remainder (4))", async () => {
    // regexp2 accepts \p{...} natively (models/issues/pull.go:892 compiles
    // `^\p{Lu}.*$`); without the u flag JS compiles the same text as the
    // LITERAL `p{Lu}` — a rule that parses, resolves owners and can never
    // match a real path. (The tokenizer eats one escape level: the file's
    // `\\p{Lu}` reaches the parser as `\p{Lu}`, same convention as `\\.`.)
    const { rules, warnings } = await parseCodeOwners(env.DB, String.raw`\\p{Lu}.* @alice` + "\n");
    expect(warnings).toEqual([]);
    expect(rules[0]!.regexp.test("README.md")).toBe(true);
    expect(rules[0]!.regexp.test("readme.md")).toBe(false);
    // Unicode-mode matching runs over code points: one astral letter is ONE
    // \p{L}, the way Go strings count it upstream.
    const single = await parseCodeOwners(env.DB, String.raw`data/\\p{L}\\.bin @alice` + "\n");
    expect(single.warnings).toEqual([]);
    expect(single.rules[0]!.regexp.test("data/𝐀.bin")).toBe(true);
  });

  it("patterns the u-mode grammar rejects keep the Annex B compile (no regression on .NET-accepted escapes)", async () => {
    // `\-` outside a class: regexp2/.NET accepts it (identity escape); the
    // u-mode grammar does not. The fallback keeps the pre-u compile, so the
    // rule still matches instead of dropping to a warning.
    const { rules, warnings } = await parseCodeOwners(env.DB, String.raw`foo\\-bar/.* @alice` + "\n");
    expect(warnings).toEqual([]);
    expect(rules[0]!.regexp.test("foo-bar/keep.md")).toBe(true);
    expect(rules[0]!.regexp.test("foobar/keep.md")).toBe(false);
  });

  it("the safety screen covers property classes: (\\p{L}+)+ drops, (\\p{L})+ stays", async () => {
    // The exponential shapes are grammar-independent — a property class adds
    // no backtracking power, and the screen (a static scan ahead of the
    // compile) must not be blinded by the brace of a property escape.
    const nested = await parseCodeOwners(env.DB, String.raw`(\\p{L}+)+ @alice` + "\n");
    expect(nested.rules).toEqual([]);
    expect(nested.warnings[0]).toContain("match-time safety bound");
    const safe = await parseCodeOwners(env.DB, String.raw`(\\p{L})+ @alice` + "\n");
    expect(safe.rules).toHaveLength(1);
    expect(safe.warnings).toEqual([]);
  });

  it("strip order: the leading ! then the leading / (:888-895)", async () => {
    const { rules } = await parseCodeOwners(env.DB, "!/docs/.* @alice\n");
    expect(rules[0]!.negative).toBe(true);
    expect(rules[0]!.pattern).toBe("docs/.*");
    expect(rules[0]!.regexp.test("docs/x")).toBe(true);
  });

  it("an uncompilable pattern drops the line with the upstream warning text", async () => {
    const { rules, warnings } = await parseCodeOwners(env.DB, "docs/(unclosed @alice\n");
    expect(rules).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("incorrect codeowner regexp:");
  });

  it("glob-style patterns are NOT the language — `*.md` is an invalid regex upstream too", async () => {
    const { rules, warnings } = await parseCodeOwners(env.DB, "*.md @alice\n");
    expect(rules).toEqual([]);
    expect(warnings[0]).toContain("incorrect codeowner regexp:");
  });

  it("the match-time safety screen drops the exponential shapes (the MatchTimeout reduction)", async () => {
    // (a+)+ — upstream's own timeout-test pattern (testCodeOwnerPatternMatchTimeout).
    const nested = await parseCodeOwners(env.DB, "(a+)+ @alice\n");
    expect(nested.rules).toEqual([]);
    expect(nested.warnings[0]).toContain("incorrect codeowner regexp:");
    expect(nested.warnings[0]).toContain("match-time safety bound");
    // A quantified backreference — the second classic shape (`\\1` reaches
    // the parser as `\1`; a single `\1` would tokenize to the literal `1`).
    const backref = await parseCodeOwners(env.DB, String.raw`(a)\\1* @alice` + "\n");
    expect(backref.rules).toEqual([]);
    expect(backref.warnings[0]).toContain("match-time safety bound");
    // Nested-group quantifier under an outer unbounded quantifier.
    const outer = await parseCodeOwners(env.DB, "(x|y.*)* @alice\n");
    expect(outer.rules).toEqual([]);
    // Safe families stay: bounded groups, plain classes, bounded repeats.
    const safe = await parseCodeOwners(env.DB, String.raw`(docs|src)/[a-z]+\.md @alice` + "\n");
    expect(safe.rules).toHaveLength(1);
    expect(safe.warnings).toEqual([]);
    const bounded = await parseCodeOwners(env.DB, "(a+){2,3} @alice\n");
    expect(bounded.rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The owner resolution (:912-946) over real D1 rows.
// ---------------------------------------------------------------------------

describe("ParseCodeOwnersLine — owner resolution (over D1)", () => {
  it("resolves a plain user case-insensitively (GetUserByName's lower_name probe)", async () => {
    const { rule, warnings } = await parseCodeOwnersLine(env.DB, ["a.md", "@ALICE"]);
    expect(warnings).toEqual([]);
    expect(rule!.users).toEqual([{ id: 1, login: "alice" }]);
    expect(rule!.teams).toEqual([]);
  });

  it("resolves an ORG name as a plain user owner (GetUserByName is type-blind, user.go:1131-1134)", async () => {
    const { rule, warnings } = await parseCodeOwnersLine(env.DB, ["a.md", "@launch-org"]);
    expect(warnings).toEqual([]);
    expect(rule!.users).toEqual([{ id: 5, login: "launch-org" }]);
  });

  it("warns on a missing user with the upstream text", async () => {
    const { rule, warnings } = await parseCodeOwnersLine(env.DB, ["a.md", "@ghost"]);
    expect(rule).toBeNull();
    expect(warnings).toEqual(["incorrect codeowner user: ghost", "no users/groups matched"]);
  });

  it("resolves @org/team by DISPLAY-case name over the org's teams", async () => {
    const good = await parseCodeOwnersLine(env.DB, ["a.md", "@launch-org/Backend"]);
    expect(good.warnings).toEqual([]);
    expect(good.rule!.teams).toEqual([{ id: 101, name: "Backend" }]);
    // A display-case mismatch skips the team SILENTLY (:935-939 — only the
    // team LOAD error warns); the ownerless rule then drops through the
    // standard no-owners arm.
    const wrongCase = await parseCodeOwnersLine(env.DB, ["a.md", "@launch-org/backend"]);
    expect(wrongCase.rule).toBeNull();
    expect(wrongCase.warnings).toEqual(["no users/groups matched"]);
  });

  it("warns on a missing org and on wrong segment counts", async () => {
    const noOrg = await parseCodeOwnersLine(env.DB, ["a.md", "@ghost-org/team"]);
    expect(noOrg.rule).toBeNull();
    expect(noOrg.warnings).toEqual(["incorrect codeowner organization: ghost-org/team", "no users/groups matched"]);

    const threeSeg = await parseCodeOwnersLine(env.DB, ["a.md", "@org/a/b"]);
    expect(threeSeg.rule).toBeNull();
    expect(threeSeg.warnings).toEqual(["incorrect codeowner group: org/a/b", "no users/groups matched"]);
  });

  it("mixes users and teams on one rule; drops a rule whose owners all miss", async () => {
    const mixed = await parseCodeOwnersLine(env.DB, ["a.md", "@alice", "@launch-org/Frontend", "@ghost"]);
    expect(mixed.warnings).toEqual(["incorrect codeowner user: ghost"]);
    expect(mixed.rule!.users).toEqual([{ id: 1, login: "alice" }]);
    expect(mixed.rule!.teams).toEqual([{ id: 102, name: "Frontend" }]);
  });
});

// ---------------------------------------------------------------------------
// The content parser (:833-864).
// ---------------------------------------------------------------------------

describe("parseCodeOwners (GetCodeOwnersFromContent)", () => {
  it("empty content → no rules, no warnings (:836-838)", async () => {
    expect(await parseCodeOwners(env.DB, "")).toEqual({ rules: [], warnings: [] });
  });

  it("comments and blank lines skip; single-token lines warn with the 1-based line number", async () => {
    const { rules, warnings } = await parseCodeOwners(env.DB, "# header\n\nonlypattern\n\na.md @alice\n");
    expect(rules).toHaveLength(1);
    expect(warnings).toEqual(["Line: 3: incorrect format"]);
  });

  it("per-line warnings carry the line prefix (:846-850)", async () => {
    const { warnings } = await parseCodeOwners(env.DB, "a.md @ghost\nb.md @ghost\n");
    expect(warnings).toEqual([
      "Line: 1: incorrect codeowner user: ghost",
      "Line: 1: no users/groups matched",
      "Line: 2: incorrect codeowner user: ghost",
      "Line: 2: no users/groups matched",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The matcher (getMatchingCodeOwnerRules' loop, services/issue/pull.go:125-145).
// ---------------------------------------------------------------------------

describe("matchCodeOwnerRules (services/issue/pull.go:125-145)", () => {
  const build = (pattern: string, negative = false) => ({
    regexp: new RegExp(`^${pattern.startsWith("!") ? pattern.slice(1) : pattern}$`),
    negative,
    pattern,
    users: [{ id: 1, login: "alice" }],
    teams: [],
  });

  it("selects a rule on the FIRST matching file; every matching rule joins", () => {
    const rules = [build("docs/.*"), build("src/.*")];
    const { matching, complete } = matchCodeOwnerRules(rules, ["src/a.go", "docs/b.md"]);
    expect(complete).toBe(true);
    // rule 1 matches on docs/b.md (src/a.go missed), rule 2 on src/a.go —
    // each rule's file loop breaks at its own first hit; rules keep their order.
    expect(matching).toEqual([rules[0], rules[1]]);
  });

  it("negative rules invert: a matching file does NOT select them, a non-matching file does", () => {
    const negative = build(".*", true); // the `!.*` family: matches every path → never fires
    const positive = build("docs/.*");
    const hit = matchCodeOwnerRules([negative, positive], ["docs/a.md"]);
    // docs/a.md MATCHES the negative rule's regex → matched == negative → the
    // negative rule does NOT fire; the positive one does.
    expect(hit.matching).toEqual([positive]);
    // A file OUTSIDE a negative rule's regex (matched=false) flips the
    // predicate: the rule FIRES.
    const outside = build("docs/.*", true);
    const miss = matchCodeOwnerRules([outside], ["src/a.go"]);
    expect(miss.matching).toEqual([outside]);
    const emptyRepo = matchCodeOwnerRules([negative, positive], []);
    expect(emptyRepo.matching).toEqual([]);
  });

  it("a rule with no matching file is absent; changed-file order only breaks ties", () => {
    const rules = [build("docs/.*"), build(String.raw`.*\.md`)];
    const { matching } = matchCodeOwnerRules(rules, ["src/a.go", "readme.md"]);
    expect(matching).toEqual([rules[1]]);
  });

  it("the budget truncation sets complete=false and stops evaluating (the fail-closed carrier)", () => {
    const rules = [build(".*"), build("docs/.*")];
    // A past deadline (budgetMs -1) truncates before the first rule — the
    // same-instant case (budget 0) still evaluates, matching upstream's
    // After() polarity.
    const { matching, complete } = matchCodeOwnerRules(rules, ["x"], -1);
    expect(complete).toBe(false);
    expect(matching).toEqual([]);
    const bounded = matchCodeOwnerRules(rules, ["x", "docs/y"], 60_000);
    expect(bounded.complete).toBe(true);
    expect(bounded.matching).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The discovery read (services/issue/pull.go:69-110) over a scripted readBlob.
// ---------------------------------------------------------------------------

describe("discoverCodeOwnerRules (services/issue/pull.go:69-110)", () => {
  const blob = (content: string) => ({ data: new TextEncoder().encode(content) });

  it("no candidate at any path → [] (never an error, :97-100's empty-data arm generalized)", async () => {
    const rules = await discoverCodeOwnerRules(env.DB, () => Promise.resolve(null));
    expect(rules).toEqual([]);
  });

  it("precedence: the root CODEOWNERS wins over docs/ and .gitea/ (codeOwnerFiles order)", async () => {
    const seen: string[] = [];
    const rules = await discoverCodeOwnerRules(env.DB, (path) => {
      seen.push(path);
      if (path === "CODEOWNERS") return Promise.resolve(blob(".*/ @alice\n"));
      if (path === "docs/CODEOWNERS") return Promise.resolve(blob(".*/ @bob\n"));
      return Promise.resolve(null);
    });
    expect(seen[0]).toBe("CODEOWNERS");
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(1);
    expect(rules![0]!.users).toEqual([{ id: 1, login: "alice" }]);
    // the docs/ candidate never even parses (the first found breaks the walk)
    expect(seen).toEqual(["CODEOWNERS"]);
  });

  it("falls through a missing root to docs/, then .gitea/ (:82-85)", async () => {
    const rules = await discoverCodeOwnerRules(env.DB, (path) => Promise.resolve(path === ".gitea/CODEOWNERS" ? blob("a.md @bob\n") : null));
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(1);
    expect(rules![0]!.users).toEqual([{ id: 2, login: "bob" }]);
  });

  it("a found-but-EMPTY file is a miss that stops the walk with [] (:97-100)", async () => {
    const rules = await discoverCodeOwnerRules(env.DB, (path) => Promise.resolve(path === "docs/CODEOWNERS" ? blob("") : blob("should not parse\n")));
    expect(rules).toEqual([]);
  });

  it("a found file of all-invalid lines → [] (the zero-rules arm, :103-106)", async () => {
    const rules = await discoverCodeOwnerRules(env.DB, (path) => Promise.resolve(path === "CODEOWNERS" ? blob("lonetoken\n") : null));
    expect(rules).toEqual([]);
  });

  it("an over-MaxDisplayFileSize blob answers NULL — fail closed (:75-79)", async () => {
    const rules = await discoverCodeOwnerRules(env.DB, (path) => Promise.resolve(path === "CODEOWNERS" ? { data: new Uint8Array(MAX_CODEOWNERS_BYTES + 1) } : null));
    expect(rules).toBeNull();
  });

  it("a readBlob THROW moves to the next candidate (:82-85 — any error continues)", async () => {
    const rules = await discoverCodeOwnerRules(env.DB, (path) => {
      if (path === "CODEOWNERS") return Promise.reject(new Error("storage blip"));
      if (path === "docs/CODEOWNERS") return Promise.resolve(blob("a.md @bob\n"));
      return Promise.resolve(null);
    });
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(1);
    expect(rules![0]!.users).toEqual([{ id: 2, login: "bob" }]);
  });

  it("parses a real multi-rule file against the seeded owners", async () => {
    const content = ["# ownership", "docs/ @alice @launch-org/Backend", String.raw`.*\.md @bob`, "!/vendor/ @mia"].join("\n");
    const rules = await discoverCodeOwnerRules(env.DB, () => Promise.resolve(blob(content)));
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(3);
    expect(rules![0]!.users.map((u) => u.id)).toEqual([1]);
    expect(rules![0]!.teams.map((t) => t.name)).toEqual(["Backend"]);
    expect(rules![1]!.regexp.test("keep.md")).toBe(true);
    expect(rules![2]!.negative).toBe(true);
  });
});
