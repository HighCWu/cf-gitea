/**
 * The B-46 xref lane's pins — extraction (ported verbatim from upstream's
 * gold fixtures), the writers on real D1, and the reader arms the writers
 * activate.
 *
 * Extraction: gitea/modules/references/references_test.go at the pin —
 * TestConvertFullHTMLReferencesToShortRefs (:32-50), TestFindAllIssueReferences
 * (:52-325 — the 30-row markdown table, the 4 url-keyword rows, the 4 bare-URL
 * rows, the 2 alnum rows), TestFindRenderizableCommitCrossReference (:368-427),
 * TestRegExp_issueNumericPattern (:486-514), TestRegExp_issueAlphanumericPattern
 * (:516-551), TestCustomizeCloseKeywords (:553-588 — the Spanish set, which
 * also pins the byte-offset RefSpans: `Cerró` is 6 bytes), TestParseCloseKeywords
 * (:590-623). Spans are UTF-8 BYTE offsets — upstream's unit (see xref.ts's
 * module header).
 *
 * Writers: the create arm (issue + PR — the shared NewIssueWithIndex tail),
 * the edit arms (ChangeIssueTitle / ChangeIssueContent tails) with the
 * neuter/keep fold, the resolution gates (cross-repo skip, unreadable target,
 * blocked doer, the close/reopen demotions, the same-repo exception), and the
 * num_comments/updated_unix convention on the referenced issue.
 *
 * Reader: the ref_issue/ref_comment enrichment arms (ToTimelineComment,
 * services/convert/issue_comment.go:130-151) and the isXRefCommentAccessible
 * timeline filter (routers/api/v1/repo/issue_comment.go:205-222) through the
 * timeline route.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { comments, issues, repoCollaborators, repositories, userBlocking, users } from "../../db/schema";
import { CommentType, RefAction } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { createApiRouter } from "../router";
import { changeIssueBody, deleteComment, updateCommentBody } from "./issues";
import {
  convertFullHtmlReferencesToShortRefs,
  findAllIssueReferences,
  findAllIssueReferencesMarkdownRaw,
  findRenderizableCommitCrossReference,
  findRenderizableReferenceAlphanumeric,
  giteaIssuePullPattern,
  ISSUE_ALPHANUMERIC_SOURCE,
  ISSUE_NUMERIC_SOURCE,
  makeKeywords,
  parseKeywords,
  type RawReference,
  type RefActionValue,
  type RefSpan,
  syncIssueCrossReferences,
  VALID_NAME_PATTERN,
} from "./xref";

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const T0 = new Date("2026-03-04T05:06:07Z");
const T1 = new Date("2026-03-04T06:07:08Z");

// ---------------------------------------------------------------------------
// Extraction (pure — no D1)
// ---------------------------------------------------------------------------

/** The fixtures' AppURL (references_test.go:330). */
const APP_URL = "https://gitea.com:3000/";
const OPTS = { appUrl: APP_URL };

/** One expected raw reference (the Go testResult row). */
interface ExpRef {
  index: number;
  owner: string;
  name: string;
  issue: string;
  isPull: boolean;
  action: RefActionValue;
  ref: [number, number] | null;
  act: [number, number] | null;
  timeLog: string;
}

function exp(
  index: number,
  owner: string,
  name: string,
  issue: string,
  isPull: boolean,
  action: RefActionValue,
  ref: [number, number] | null = null,
  act: [number, number] | null = null,
  timeLog = "",
): ExpRef {
  return { index, owner, name, issue, isPull, action, ref, act, timeLog };
}

function span(pair: [number, number] | null): RefSpan | null {
  return pair === null ? null : { start: pair[0], end: pair[1] };
}

function expectRawRefs(raw: RawReference[], expected: ExpRef[]): void {
  expect(raw).toHaveLength(expected.length);
  expected.forEach((e, i) => {
    const r = raw[i]!;
    expect(
      {
        index: r.index,
        owner: r.owner,
        name: r.name,
        issue: r.issue,
        isPull: r.isPull,
        action: r.action,
        refLocation: r.refLocation,
        actionLocation: r.actionLocation,
        timeLog: r.timeLog,
      },
      `row ${i}`,
    ).toEqual({
      index: e.index,
      owner: e.owner,
      name: e.name,
      issue: e.issue,
      isPull: e.isPull,
      action: e.action,
      refLocation: span(e.ref),
      actionLocation: span(e.act),
      timeLog: e.timeLog,
    });
  });
}

describe("convertFullHTMLReferencesToShortRefs (references_test.go:32-50)", () => {
  const test = `this is a https://ourgitea.com/git/owner/repo/issues/123456789, foo
https://ourgitea.com/git/owner/repo/pulls/123456789
  And https://ourgitea.com/git/owner/repo/pulls/123
`;
  const expected = `this is a owner/repo#123456789, foo
owner/repo!123456789
  And owner/repo!123
`;

  it("rewrites AppURL-prefixed issue and pull URLs into short refs verbatim", () => {
    const pattern = giteaIssuePullPattern("https://ourgitea.com/git/");
    expect(pattern).not.toBeNull();
    if (pattern === null) return;
    expect(convertFullHtmlReferencesToShortRefs(pattern, test)).toBe(expected);
  });

  it("answers null for an empty AppURL — the nil-pattern arm (:333-337)", () => {
    expect(giteaIssuePullPattern("")).toBeNull();
  });
});

describe("TestFindAllIssueReferences — the markdown fixture table (:52-235)", () => {
  const A = RefAction.None;
  const C = RefAction.Closes;
  const R = RefAction.Reopens;
  const fixtures: Array<[string, ExpRef[]]> = [
    ["Simply closes: #29 yes", [exp(29, "", "", "29", false, C, [15, 18], [7, 13])]],
    ["Simply closes: !29 yes", [exp(29, "", "", "29", true, C, [15, 18], [7, 13])]],
    [" #124 yes, this is a reference.", [exp(124, "", "", "124", false, A, [0, 4])]],
    ["```\nThis is a code block.\n#723 no, it's a code block.```", []],
    ["This `#724` no, it's inline code.", []],
    ["This org3/repo4#200 yes.", [exp(200, "org3", "repo4", "200", false, A, [5, 19])]],
    ["This org3/repo4!200 yes.", [exp(200, "org3", "repo4", "200", true, A, [5, 19])]],
    ["This [one](#919) no, this is a URL fragment.", []],
    ["This [two](/user2/repo1/issues/921) yes.", [exp(921, "user2", "repo1", "921", false, A)]],
    ["This [three](/user2/repo1/pulls/922) yes.", [exp(922, "user2", "repo1", "922", true, A)]],
    ["This [four](http://gitea.com:3000/org3/repo4/issues/203) yes.", [exp(203, "org3", "repo4", "203", false, A)]],
    ["This [five](http://github.com/org3/repo4/issues/204) no.", []],
    ["This http://gitea.com:3000/user4/repo5/201 no, bad URL.", []],
    ["This http://gitea.com:3000/user4/repo5/pulls/202 yes.", [exp(202, "user4", "repo5", "202", true, A)]],
    [
      "This http://gitea.com:3000/user4/repo5/pulls/202 yes. http://gitea.com:3000/user4/repo5/pulls/203 no",
      [exp(202, "user4", "repo5", "202", true, A), exp(203, "user4", "repo5", "203", true, A)],
    ],
    ["This http://GiTeA.COM:3000/user4/repo6/pulls/205 yes.", [exp(205, "user4", "repo6", "205", true, A)]],
    ["Reopens #15 yes", [exp(15, "", "", "15", false, R, [8, 11], [0, 7])]],
    ["This closes #20 for you yes", [exp(20, "", "", "20", false, C, [12, 15], [5, 11])]],
    ["Do you fix org6/repo6#300 ? yes", [exp(300, "org6", "repo6", "300", false, C, [11, 25], [7, 10])]],
    ["For 999 #1235 no keyword, but yes", [exp(1235, "", "", "1235", false, A, [8, 13])]],
    [
      "After a long investigation into the root cause, this resolves #1, unlike the still unresolved #2",
      [exp(1, "", "", "1", false, C, [62, 64], [53, 61]), exp(2, "", "", "2", false, A, [94, 96])],
    ],
    ["For [!123] yes", [exp(123, "", "", "123", true, A, [5, 9])]],
    ["For (#345) yes", [exp(345, "", "", "345", false, A, [5, 9])]],
    ["For #22,#23 no, neither #28:#29 or !30!31#32;33 should", []],
    [
      "For #24, and #25. yes; also #26; #27? #28! and #29: should",
      [
        exp(24, "", "", "24", false, A, [4, 7]),
        exp(25, "", "", "25", false, A, [13, 16]),
        exp(26, "", "", "26", false, A, [28, 31]),
        exp(27, "", "", "27", false, A, [33, 36]),
        exp(28, "", "", "28", false, A, [38, 41]),
        exp(29, "", "", "29", false, A, [47, 50]),
      ],
    ],
    ["This org3/repo4#200, yes.", [exp(200, "org3", "repo4", "200", false, A, [5, 19])]],
    [
      "Merge pull request '#12345 My fix for a bug' (!1337) from feature-branch into main",
      [exp(12345, "", "", "12345", false, A, [20, 26]), exp(1337, "", "", "1337", true, A, [46, 51])],
    ],
    ["Which abc. #9434 same as above", [exp(9434, "", "", "9434", false, A, [11, 16])]],
    [
      "This closes #600 and reopens #599",
      [exp(600, "", "", "600", false, C, [12, 16], [5, 11]), exp(599, "", "", "599", false, R, [29, 33], [21, 28])],
    ],
    [
      "This fixes #100 spent @40m and reopens #101, also fixes #102 spent @4h15m",
      [
        exp(100, "", "", "100", false, C, [11, 15], [5, 10], "40m"),
        exp(101, "", "", "101", false, R, [39, 43], [31, 38]),
        exp(102, "", "", "102", false, C, [56, 60], [50, 55], "4h15m"),
      ],
    ],
  ];

  it.each(fixtures)("parses %# %s", (input, expected) => {
    expectRawRefs(findAllIssueReferencesMarkdownRaw(input, OPTS), expected);
  });
});

describe("url-keyword fixtures (:239-267)", () => {
  const fixtures: Array<[string, ExpRef[]]> = [
    ["Closes [this issue](https://gitea.com:3000/user/repo/issues/123)", [exp(123, "user", "repo", "123", false, RefAction.Closes, null, [0, 6])]],
    ["This fixes [#456](https://gitea.com:3000/org/project/issues/456)", [exp(456, "org", "project", "456", false, RefAction.Closes, null, [5, 10])]],
    ["Reopens [PR](https://gitea.com:3000/owner/repo/pulls/789)", [exp(789, "owner", "repo", "789", true, RefAction.Reopens, null, [0, 7])]],
    [
      "See [issue](https://gitea.com:3000/user/repo/issues/100) but closes [another](https://gitea.com:3000/user/repo/issues/200)",
      [exp(100, "user", "repo", "100", false, RefAction.None), exp(200, "user", "repo", "200", false, RefAction.Closes, null, [61, 67])],
    ],
  ];
  it.each(fixtures)("parses %# %s", (input, expected) => {
    expectRawRefs(findAllIssueReferencesMarkdownRaw(input, OPTS), expected);
  });
});

describe("bare-URL rows — the TITLE path with keywords (:269-291)", () => {
  // FindAllIssueReferences (the non-markdown entry): the AppURL rewrite fires,
  // then the action keyword is searched in the REWRITTEN content.
  const cases: Array<[string, string]> = [
    ["Fixes https://gitea.com:3000/org/project/issues/456", "org"],
    ["Fixes: https://gitea.com:3000/org/project/issues/456", "org"],
    ["Closes https://gitea.com:3000/user/repo/issues/123", "user"],
    ["Closes: https://gitea.com:3000/user/repo/issues/123", "user"],
  ];
  it.each(cases)("resolves one closes-reference for %s", (input, owner) => {
    const refs = findAllIssueReferences(input, OPTS);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.action).toBe(RefAction.Closes);
    expect(refs[0]?.owner).toBe(owner);
  });

  it("leaves full URLs unscanned without an AppURL (the nil-pattern arm)", () => {
    expect(findAllIssueReferences("Fixes https://gitea.com:3000/org/project/issues/456", { appUrl: "" })).toEqual([]);
  });
});

describe("alnum fixtures (:293-325)", () => {
  it("parses the two alphanumeric render rows", () => {
    expect(findRenderizableReferenceAlphanumeric("This ref ABC-123 is alphanumeric")).toEqual({
      issue: "ABC-123",
      owner: "",
      name: "",
      commitSha: "",
      isPull: false,
      refLocation: { start: 9, end: 16 },
      action: RefAction.None,
      actionLocation: null,
    });
    expect(findRenderizableReferenceAlphanumeric("This closes ABCD-1234 alphanumeric")).toEqual({
      issue: "ABCD-1234",
      owner: "",
      name: "",
      commitSha: "",
      isPull: false,
      refLocation: { start: 12, end: 21 },
      action: RefAction.Closes,
      actionLocation: { start: 5, end: 11 },
    });
  });
});

describe("TestFindRenderizableCommitCrossReference (:368-427)", () => {
  const found = (owner: string, name: string, commitSha: string, start: number, end: number) => ({
    issue: "",
    owner,
    name,
    commitSha,
    isPull: false,
    refLocation: { start, end },
    action: RefAction.None,
    actionLocation: null,
  });
  const cases: Array<[string, ReturnType<typeof findRenderizableCommitCrossReference>]> = [
    ["", null],
    ["test", null],
    ["go-gitea/gitea@test", null],
    ["go-gitea/gitea@ab1234", null],
    ["go-gitea/gitea@abcd1234", found("go-gitea", "gitea", "abcd1234", 0, 23)],
    [
      "go-gitea/gitea@abcd1234abcd1234abcd1234abcd1234abcd1234",
      found("go-gitea", "gitea", "abcd1234abcd1234abcd1234abcd1234abcd1234", 0, 55),
    ],
    // Longer than 64 hex characters.
    ["go-gitea/gitea@abcd1234abcd1234abcd1234abcd1234abcd12341234512345123451234512345", null],
    ["test go-gitea/gitea@abcd1234 test", found("go-gitea", "gitea", "abcd1234", 5, 28)],
  ];
  it.each(cases)("parses %# %s", (input, expected) => {
    expect(findRenderizableCommitCrossReference(input)).toEqual(expected);
  });
});

describe("TestRegExp_issueNumericPattern (:486-514)", () => {
  const re = new RegExp(ISSUE_NUMERIC_SOURCE);
  const trueCases = ["#1234", "#0", "#1234567890987654321", "  #12", "#12:", "ref: #12: msg", '"#1234"', "'#1234'"];
  const falseCases = ["# 1234", "# 0", "# ", "#", "#ABC", "#1A2B", "", "ABC"];
  it.each(trueCases)("matches %s", (c) => {
    expect(re.test(c)).toBe(true);
  });
  it.each(falseCases)("rejects %j", (c) => {
    expect(re.test(c)).toBe(false);
  });
});

describe("TestRegExp_issueAlphanumericPattern (:516-551)", () => {
  const re = new RegExp(ISSUE_ALPHANUMERIC_SOURCE);
  const trueCases = [
    "ABC-1234",
    "A-1",
    "RC-80",
    "ABCDEFGHIJ-1234567890987654321234567890",
    "ABC-123.",
    "(ABC-123)",
    "[ABC-123]",
    "ABC-123:",
    '"ABC-123"',
    "'ABC-123'",
    "ABC-123, unknown PR",
  ];
  const falseCases = ["RC-08", "PR-0", "ABCDEFGHIJK-1", "PR_1", "", "#ABC", "ABC", "GG-", "rm-1", "/home/gitea/ABC-1234", "MY-STRING-ABC-123"];
  it.each(trueCases)("matches %s", (c) => {
    expect(re.test(c)).toBe(true);
  });
  it.each(falseCases)("rejects %j", (c) => {
    expect(re.test(c)).toBe(false);
  });
});

describe("validNamePattern (:25)", () => {
  it("accepts the basic lowercase name class and nothing else", () => {
    expect(VALID_NAME_PATTERN.test("org3")).toBe(true);
    expect(VALID_NAME_PATTERN.test("repo_4.x-y")).toBe(true);
    expect(VALID_NAME_PATTERN.test("a/b")).toBe(false);
    expect(VALID_NAME_PATTERN.test("")).toBe(false);
    expect(VALID_NAME_PATTERN.test("Org3")).toBe(false);
  });
});

describe("TestCustomizeCloseKeywords (:553-588)", () => {
  const spanish = makeKeywords(["cierra", "cerró"], ["reabre"]);
  const fixtures: Array<[string, ExpRef[]]> = [
    ["Simplemente cierra: #29 yes", [exp(29, "", "", "29", false, RefAction.Closes, [20, 23], [12, 18])]],
    ["Closes: #123 no, this English.", [exp(123, "", "", "123", false, RefAction.None, [8, 12])]],
    // The byte-offset pins: `Cerró` is 6 UTF-8 bytes, so the ref starts at 7.
    ["Cerró org6/repo6#300 yes", [exp(300, "org6", "repo6", "300", false, RefAction.Closes, [7, 21], [0, 6])]],
    ["Reabre org3/repo4#200 yes", [exp(200, "org3", "repo4", "200", false, RefAction.Reopens, [7, 21], [0, 6])]],
  ];
  it.each(fixtures)("parses %# %s", (input, expected) => {
    expectRawRefs(findAllIssueReferencesMarkdownRaw(input, { appUrl: APP_URL, keywords: spanish }), expected);
  });
});

describe("TestParseCloseKeywords (:590-623)", () => {
  it("drops non-letter keywords", () => {
    expect(parseKeywords([""])).toEqual([]);
    expect(parseKeywords(["  aa  ", " bb  ", "99", "#", "", "this is", "cc"])).toEqual(["aa", "bb", "cc"]);
  });

  const cases: Array<[string, string, string]> = [
    ["close", "This PR will close ", "close"],
    ["cerró", "cerró ", "cerró"],
    ["cerró", "AQUÍ SE CERRÓ: ", "CERRÓ"],
    ["закрывается", "закрывается ", "закрывается"],
    ["κλείνει", "κλείνει: ", "κλείνει"],
    ["关闭", "关闭 ", "关闭"],
    [",$!", "", ""],
    ["1234", "", ""],
  ];

  it.each(cases)("compiles %j against %j", (word, match, expected) => {
    const compiled = makeKeywords([word], []);
    if (expected === "") {
      expect(compiled.close).toBeNull();
      return;
    }
    expect(compiled.close).not.toBeNull();
    expect(compiled.close?.exec(match)?.[1]).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// The writers on real D1
// ---------------------------------------------------------------------------

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

let repoSeq = 900;

async function seedRepo(ownerNamespace: string, slug: string, options: { private?: boolean; ownerId?: number } = {}): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    ownerId: options.ownerId ?? null,
    visibility: options.private === true ? "private" : "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
  return id;
}

/** One issue through the landed service (indexes allocate 1, 2, …). */
async function seedIssue(repoId: string, title: string, options: { posterId?: number | null; content?: string | null } = {}) {
  return service().createIssue({
    repoId,
    title,
    content: options.content ?? null,
    posterId: options.posterId ?? null,
    labelIds: [],
    milestoneId: null,
    appUrl: APP_URL,
    now: T0,
  });
}

/** One same-repo pull request through the landed service. */
async function seedPull(repoId: string, title: string, posterId: number) {
  const created = await service().createPullRequest({
    repoId,
    title,
    content: null,
    posterId,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: `feature-${repoSeq++}`,
    appUrl: APP_URL,
    now: T0,
  });
  return created.issue;
}

/** The xref rows written ON `issueId` about the referring `refIssueId`. */
async function xrefRowsFor(issueId: number, refIssueId: number) {
  const rows = await db()
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.refIssueId, refIssueId)))
    .all();
  return rows.sort((a, b) => a.id - b.id);
}

/** Every xref row the origin produced, anywhere. */
async function xrefRowsFrom(refIssueId: number) {
  return db().select().from(comments).where(eq(comments.refIssueId, refIssueId)).all();
}

async function issueRow(id: number) {
  const rows = await db().select().from(issues).where(eq(issues.id, id)).limit(1).all();
  const row = rows[0];
  if (row === undefined) throw new Error(`issue ${id} missing`);
  return row;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "user_blocking",
    "repo_collaborators",
    "pull_requests",
    "comments",
    "issue_labels",
    "issue_user",
    "issue_content_history",
    "issues",
    "milestones",
    "labels",
    "repo_counters",
    "repo_settings",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity (id 1) for the route-viewer pins.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
});

describe("the create arm — NewIssueWithIndex's tail (issue_update.go:449)", () => {
  it("writes one issue_ref (3) row ON the referenced issue with the origin's ref info", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin", { posterId: alice.id, content: "See #1 for context" });

    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.type).toBe(CommentType.IssueRef);
    expect(row?.posterId).toBe(alice.id);
    expect(row?.refRepoId).toBe(repoId);
    expect(row?.refIssueId).toBe(origin.id);
    expect(row?.refCommentId).toBeNull();
    expect(row?.refAction).toBe(RefAction.None);
    expect(row?.refIsPull).toBe(false);
    expect(row?.content).toBe("");
    // Exactly one row anywhere for this origin.
    expect(await xrefRowsFrom(origin.id)).toHaveLength(1);
  });

  it("scans the TITLE too (the non-markdown entry)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "follow-up to #1", { posterId: alice.id });
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(1);
  });

  it("folds duplicate references to one row", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "about #1", { posterId: alice.id, content: "again #1 and once more #1" });
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(1);
  });

  it("demotes close keywords to none when the origin is a plain issue (:205-207)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "Fixes #1", { posterId: alice.id });
    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refAction).toBe(RefAction.None);
  });

  it("moves num_comments/updated_unix on the referenced issue only (the repo convention)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const before = await issueRow(target.id);
    const origin = await service().createIssue({
      repoId,
      title: "origin",
      content: "See #1",
      posterId: alice.id,
      appUrl: APP_URL,
      now: T1,
    });
    const after = await issueRow(target.id);
    expect(after.numComments).toBe(before.numComments + 1);
    expect(after.updatedAt?.getTime()).toBe(T1.getTime());
    expect((await issueRow(origin.id)).numComments).toBe(0);
  });

  it("writes nothing for content without references", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "plain title", { posterId: alice.id, content: "no refs, just `#1` in code" });
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
  });
});

describe("the PR create arm — NewPullRequest shares NewIssueWithIndex (pull.go:478)", () => {
  it("writes pull_ref (6) rows with closes intact and ref_is_pull set", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const pr = await seedPull(repoId, "Fixes #1", alice.id);
    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(CommentType.PullRef);
    expect(rows[0]?.refAction).toBe(RefAction.Closes);
    expect(rows[0]?.refIsPull).toBe(true);
    expect(rows[0]?.posterId).toBe(alice.id);
  });

  it("reopens demote onto a PR target but survive onto an issue target (:205-207)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const issueTarget = await seedIssue(repoId, "issue target");
    const prTarget = await seedPull(repoId, "pr target", alice.id);
    const origin = await seedPull(repoId, `Reopens #${issueTarget.index} and reopens #${prTarget.index}`, alice.id);
    const ontoIssue = await xrefRowsFor(issueTarget.id, origin.id);
    expect(ontoIssue).toHaveLength(1);
    expect(ontoIssue[0]?.refAction).toBe(RefAction.Reopens);
    const ontoPr = await xrefRowsFor(prTarget.id, origin.id);
    expect(ontoPr).toHaveLength(1);
    expect(ontoPr[0]?.refAction).toBe(RefAction.None);
  });

  it("keeps a same-repo close from a non-writer non-poster doer (the merger exception, :219-232)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target", { posterId: alice.id });
    // bob: not the owner, no collaborator row, not the target's poster.
    const pr = await seedPull(repoId, "Fixes #1", bob.id);
    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refAction).toBe(RefAction.Closes);
  });
});

describe("the resolution gates (verifyReferencedIssue, issue_xref.go:193-247)", () => {
  it("skips missing target repos and missing target indexes silently (:150-155, :198-202)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const otherId = await seedRepo("alice", "other", { ownerId: alice.id });
    const otherIssue = await seedIssue(otherId, "the other repo's issue");
    const origin = await seedIssue(repoId, "origin", {
      posterId: alice.id,
      content: "see alice/other#1 and alice/nope#1 and alice/other#99",
    });
    // Only the valid cross-repo target got a row, carrying the ORIGIN repo.
    const all = await xrefRowsFrom(origin.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.issueId).toBe(otherIssue.id);
    expect(all[0]?.refRepoId).toBe(repoId);
  });

  it("drops rows whose target repo is unreadable by the doer (:217-220)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobPrivate = await seedRepo("bob", "vault", { ownerId: bob.id, private: true });
    await seedIssue(bobPrivate, "secret", { posterId: bob.id });
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const origin = await seedIssue(aliceRepo, "origin", { posterId: alice.id, content: "see bob/vault#1" });
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
  });

  it("lands the row once a collaborator grant makes the target readable", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobPrivate = await seedRepo("bob", "vault", { ownerId: bob.id, private: true });
    const target = await seedIssue(bobPrivate, "secret", { posterId: bob.id });
    await db().insert(repoCollaborators).values({ repoId: bobPrivate, userId: alice.id, mode: "read", createdAt: T0, updatedAt: T0 });
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const origin = await seedIssue(aliceRepo, "origin", { posterId: alice.id, content: "see bob/vault#1" });
    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refAction).toBe(RefAction.None);
  });

  it("reads a null doer as anonymous: public targets land, private targets drop", async () => {
    const bob = await seedUser("bob");
    const bobPublic = await seedRepo("bob", "pub2", { ownerId: bob.id });
    const publicTarget = await seedIssue(bobPublic, "public target", { posterId: bob.id });
    const bobPrivate = await seedRepo("bob", "vault", { ownerId: bob.id, private: true });
    await seedIssue(bobPrivate, "secret", { posterId: bob.id });
    const alice = await seedUser("alice");
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const origin = await seedIssue(aliceRepo, "origin", { posterId: null, content: "see bob/pub2#1 and bob/vault#1" });
    const all = await xrefRowsFrom(origin.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.issueId).toBe(publicTarget.id);
    expect(all[0]?.posterId).toBeNull();
  });

  it("drops rows when the doer is blocked by the target poster (:221-224)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobRepo = await seedRepo("bob", "pub2", { ownerId: bob.id });
    await seedIssue(bobRepo, "target", { posterId: bob.id });
    await db().insert(userBlocking).values({ blockerId: bob.id, blockeeId: alice.id, createdAt: T0 });
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const origin = await seedIssue(aliceRepo, "origin", { posterId: alice.id, content: "see bob/pub2#1" });
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
  });

  it("demotes actionable cross-repo refs from non-writer non-posters, keeping the row (:225-232)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobRepo = await seedRepo("bob", "pub2", { ownerId: bob.id });
    const target = await seedIssue(bobRepo, "target", { posterId: bob.id });
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const pr = await seedPull(aliceRepo, "Fixes bob/pub2#1", alice.id);
    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refAction).toBe(RefAction.None); // demoted, not dropped
  });

  it("keeps a cross-repo close when the doer IS the target's poster (:226)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobRepo = await seedRepo("bob", "pub2", { ownerId: bob.id });
    // The target is posted by alice in bob's repo; alice is no writer there.
    const target = await seedIssue(bobRepo, "target", { posterId: alice.id });
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const pr = await seedPull(aliceRepo, "Fixes bob/pub2#1", alice.id);
    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refAction).toBe(RefAction.Closes);
  });

  it("keeps a cross-repo close when the doer can write the target repo (:227)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobRepo = await seedRepo("bob", "pub2", { ownerId: bob.id });
    const target = await seedIssue(bobRepo, "target", { posterId: bob.id });
    await db().insert(repoCollaborators).values({ repoId: bobRepo, userId: alice.id, mode: "write", createdAt: T0, updatedAt: T0 });
    const aliceRepo = await seedRepo("alice", "visible", { ownerId: alice.id });
    const pr = await seedPull(aliceRepo, "Fixes bob/pub2#1", alice.id);
    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refAction).toBe(RefAction.Closes);
  });

  it("skips self-references (:179-181)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const origin = await seedIssue(repoId, "first", { posterId: alice.id });
    expect(origin.index).toBe(1);
    await service().changeTitle(origin, "about #1 itself", alice.id, T1, APP_URL);
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
  });

  it("leaves AppURL-prefixed full URLs unscanned without an AppURL (the nil-pattern arm)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin", { posterId: alice.id });
    const withUrlTitle = { ...origin, title: `see ${APP_URL}alice/visible/issues/${target.index}` };
    await syncIssueCrossReferences(env.DB, { origin: withUrlTitle, doerId: alice.id, removeOld: true, appUrl: "", now: T1 });
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
    await syncIssueCrossReferences(env.DB, { origin: withUrlTitle, doerId: alice.id, removeOld: true, appUrl: APP_URL, now: T1 });
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(1);
  });
});

describe("the edit arms — ChangeIssueTitle (:217) / ChangeIssueContent (:345)", () => {
  it("neuters removed references, keeps surviving pairs untouched, writes fresh ones", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    await seedIssue(repoId, "t1");
    const t2 = await seedIssue(repoId, "t2");
    const t3 = await seedIssue(repoId, "t3");
    const t4 = await seedIssue(repoId, "t4");
    const origin = await seedIssue(repoId, "see #2 and #3", { posterId: alice.id });
    expect(await xrefRowsFor(t2.id, origin.id)).toHaveLength(1);
    expect(await xrefRowsFor(t3.id, origin.id)).toHaveLength(1);

    // Drop #3: its row neuters; #2's row is KEPT untouched (no duplicate,
    // the created stamp unmoved); nothing lands on #4.
    await service().changeTitle(origin, "see #2", alice.id, T1, APP_URL);
    const kept = await xrefRowsFor(t2.id, origin.id);
    expect(kept.map((r) => r.refAction)).toEqual([RefAction.None]);
    expect(kept[0]?.createdAt?.getTime()).toBe(T0.getTime());
    expect((await xrefRowsFor(t3.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered]);
    expect(await xrefRowsFor(t4.id, origin.id)).toHaveLength(0);

    // Re-add #3 and add #4: the neutered row is not revived (findOld only
    // reads live rows) — a fresh row lands beside it; #2 stays one row.
    await service().changeTitle(origin, "see #2 and #3 and #4", alice.id, T1, APP_URL);
    expect(await xrefRowsFor(t2.id, origin.id)).toHaveLength(1);
    expect((await xrefRowsFor(t3.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered, RefAction.None]);
    expect((await xrefRowsFor(t4.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
  });

  it("re-pairs an action change: the old row neuters and a fresh row lands", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedPull(repoId, "Fixes #1", alice.id);
    expect((await xrefRowsFor(target.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Closes]);

    // closes → plain: the (target, action) pair no longer matches.
    await service().changeTitle(origin, "see #1", alice.id, T1, APP_URL);
    expect((await xrefRowsFor(target.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered, RefAction.None]);
  });

  it("the body edit path (ChangeIssueContent) neuters and writes over the new content", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    await seedIssue(repoId, "t1");
    const t2 = await seedIssue(repoId, "t2");
    const t3 = await seedIssue(repoId, "t3");
    const origin = await seedIssue(repoId, "origin", { posterId: alice.id, content: "see #2" });
    expect(await xrefRowsFor(t2.id, origin.id)).toHaveLength(1);

    const row = await changeIssueBody(env.DB, origin, "see #3", origin.contentVersion, T1, alice.id, APP_URL);
    expect(row).not.toBeNull();
    expect((await xrefRowsFor(t2.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered]);
    expect((await xrefRowsFor(t3.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
  });

  it("a stale content_version writes nothing (the CAS loser never reaches the scan)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    await seedIssue(repoId, "t1");
    const t2 = await seedIssue(repoId, "t2");
    const origin = await seedIssue(repoId, "origin", { posterId: alice.id });
    const row = await changeIssueBody(env.DB, origin, "see #2", origin.contentVersion + 5, T1, alice.id, APP_URL);
    expect(row).toBeNull();
    expect(await xrefRowsFor(t2.id, origin.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The route arms
// ---------------------------------------------------------------------------

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`https://example.com${path}`, init), env);
};
const authHeaders = { Authorization: "token stub-token", "Content-Type": "application/json" };

describe("the route arms — the request origin threads the AppURL", () => {
  it("POST /issues resolves AppURL-prefixed full URLs via the request origin", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const res = await router()("/repos/alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "origin", body: `This is https://example.com/alice/visible/issues/${target.index}, foo` }),
    });
    expect(res.status).toBe(201);
    const created = await res.json<{ id: number }>();
    const rows = await xrefRowsFor(target.id, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(CommentType.IssueRef);
    expect(rows[0]?.posterId).toBe(1);
  });

  it("PATCH title and body scan through the same origin, with removeOld", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const t1 = await seedIssue(repoId, "t1");
    const t2 = await seedIssue(repoId, "t2");
    // The stub identity (id 1) is the poster, so it may edit.
    const origin = await seedIssue(repoId, "origin", { posterId: 1 });

    const titleRes = await router()(`/repos/alice/visible/issues/${origin.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: `About https://example.com/alice/visible/issues/${t1.index}` }),
    });
    expect(titleRes.status).toBe(201);
    expect((await xrefRowsFor(t1.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);

    const bodyRes = await router()(`/repos/alice/visible/issues/${origin.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: `and #${t2.index}` }),
    });
    expect(bodyRes.status).toBe(201);
    // The title reference survives the body edit (kept, not duplicated).
    expect((await xrefRowsFor(t1.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
    expect((await xrefRowsFor(t2.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
  });
});

describe("the reader arms — ref_issue / ref_comment enrichment + the xref filter", () => {
  type TimelineRow = Record<string, unknown> & { type: string; ref_action: string };

  async function timeline(path: string, init?: RequestInit): Promise<TimelineRow[]> {
    const res = await router()(path, init);
    expect(res.status).toBe(200);
    return res.json<TimelineRow[]>();
  }

  it("renders the xref row with the full ref_issue enrichment and a null ref_comment", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin title", { posterId: alice.id, content: "See #1" });

    const rows = await timeline(`/repos/alice/visible/issues/${target.index}/timeline`);
    const xref = rows.find((r) => r.type === "issue_ref");
    expect(xref).toBeDefined();
    expect(xref?.ref_action).toBe("none");
    expect(xref?.ref_issue).toMatchObject({ id: origin.id, number: origin.index, title: "origin title" });
    expect(xref?.ref_comment).toBeNull();
    expect((xref?.user as { login?: string } | null)?.login).toBe("alice");
  });

  it("renders pull_ref rows with ref_action closes", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const pr = await seedPull(repoId, "Fixes #1", alice.id);
    const rows = await timeline(`/repos/alice/visible/issues/${target.index}/timeline`);
    const xref = rows.find((r) => r.type === "pull_ref");
    expect(xref).toBeDefined();
    expect(xref?.ref_action).toBe("closes");
    expect(xref?.ref_issue).toMatchObject({ id: pr.id, number: pr.index, title: "Fixes #1" });
  });

  it("renders a neutered row as ref_action neutered", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "see #1", { posterId: alice.id });
    await service().changeTitle(origin, "no more", alice.id, T1, APP_URL);
    const rows = await timeline(`/repos/alice/visible/issues/${target.index}/timeline`);
    expect(rows.filter((r) => r.type === "issue_ref").map((r) => r.ref_action)).toEqual(["neutered"]);
  });

  it("hides a cross-repo row whose origin repo is unreadable by the viewer (:205-222)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobRepo = await seedRepo("bob", "pub", { ownerId: bob.id });
    const target = await seedIssue(bobRepo, "target");
    const secret = await seedRepo("alice", "vault", { ownerId: alice.id, private: true });
    const origin = await seedIssue(secret, "secret origin", { posterId: alice.id, content: "see bob/pub#1" });
    // The row exists (alice can read bob/pub)…
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(1);
    // …but neither the anonymous viewer nor the grant-less stub sees it.
    const anonymous = await timeline(`/repos/bob/pub/issues/${target.index}/timeline`);
    expect(anonymous.find((r) => r.type === "issue_ref")).toBeUndefined();
    const stub = await timeline(`/repos/bob/pub/issues/${target.index}/timeline`, { headers: authHeaders });
    expect(stub.find((r) => r.type === "issue_ref")).toBeUndefined();
  });

  it("renders the cross-repo row once the viewer can read the origin repo", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const bobRepo = await seedRepo("bob", "pub", { ownerId: bob.id });
    const target = await seedIssue(bobRepo, "target");
    const secret = await seedRepo("alice", "vault", { ownerId: alice.id, private: true });
    await seedIssue(secret, "secret origin", { posterId: alice.id, content: "see bob/pub#1" });
    await db().insert(repoCollaborators).values({ repoId: secret, userId: 1, mode: "read", createdAt: T0, updatedAt: T0 });

    const rows = await timeline(`/repos/bob/pub/issues/${target.index}/timeline`, { headers: authHeaders });
    const xref = rows.find((r) => r.type === "issue_ref");
    expect(xref).toBeDefined();
    expect(xref?.ref_issue).toMatchObject({ title: "secret origin" });
  });

  it("drops rows with a dangling ref_issue_id (the GetIssueByID degenerate arm)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    await db().insert(comments).values({
      type: CommentType.IssueRef,
      posterId: alice.id,
      issueId: target.id,
      content: "",
      refRepoId: repoId,
      refIssueId: 424242,
      refAction: RefAction.None,
      refIsPull: false,
      createdAt: T0,
      updatedAt: T0,
    });
    const rows = await timeline(`/repos/alice/visible/issues/${target.index}/timeline`);
    expect(rows.find((r) => r.type === "issue_ref")).toBeUndefined();
  });

  it("renders ref_comment when the referring comment resolves; drops the dangling twin", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin", { posterId: alice.id });
    const comment = await service().addComment({ issueId: origin.id, posterId: alice.id, content: "the referring comment", now: T0 });

    const refRow = {
      type: CommentType.CommentRef,
      posterId: alice.id,
      issueId: target.id,
      content: "",
      refRepoId: repoId,
      refIssueId: origin.id,
      refAction: RefAction.None,
      refIsPull: false,
      createdAt: T0,
      updatedAt: T0,
    };
    await db().insert(comments).values({ ...refRow, refCommentId: comment.id });
    const rows = await timeline(`/repos/alice/visible/issues/${target.index}/timeline`);
    const xref = rows.find((r) => r.type === "comment_ref");
    expect(xref).toBeDefined();
    expect(xref?.ref_comment).toMatchObject({ id: comment.id, body: "the referring comment" });
    expect(xref?.ref_issue).toMatchObject({ id: origin.id });

    // The dangling twin: same row shape, a missing comment id.
    await db().insert(comments).values({ ...refRow, refCommentId: 424242 });
    const after = await timeline(`/repos/alice/visible/issues/${target.index}/timeline`);
    expect(after.filter((r) => r.type === "comment_ref")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The COMMENT arms (models/issues/comment.go:920 create / :1204 edit /
// :1234 delete-neuter) — the landed writer parameterized by the comment
// origin (`Comment.AddCrossReferences`, issue_xref.go:228-246). The reader
// pins above already proved ref_comment enrichment renders these rows.
// ---------------------------------------------------------------------------

describe("the comment create arm — CreateComment's tail (comment.go:920)", () => {
  it("writes one comment_ref (5) row ON the referenced issue carrying ref_comment_id", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    const comment = await service().addComment({
      issueId: origin.id,
      posterId: alice.id,
      content: `See #${target.index} for context`,
      now: T0,
    });

    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.type).toBe(CommentType.CommentRef);
    expect(row?.refCommentId).toBe(comment.id);
    expect(row?.refRepoId).toBe(repoId);
    expect(row?.refIssueId).toBe(origin.id);
    expect(row?.refAction).toBe(RefAction.None);
    expect(row?.refIsPull).toBe(false);
    expect(row?.posterId).toBe(alice.id);
    // The referenced issue's counters move with the row (the repo convention).
    expect((await issueRow(target.id)).numComments).toBe(1);
  });

  it("scans PER COMMENT: two referencing comments each write their own row", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    const first = await service().addComment({ issueId: origin.id, posterId: alice.id, content: `see #${target.index}`, now: T0 });
    const second = await service().addComment({ issueId: origin.id, posterId: alice.id, content: `also #${target.index}`, now: T0 });

    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows.map((r) => r.refCommentId)).toEqual([first.id, second.id]);
    expect(rows.every((r) => r.type === CommentType.CommentRef)).toBe(true);
  });

  it("demotes a close keyword from a plain-issue comment to none (:205-207)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin", { posterId: alice.id });
    await service().addComment({ issueId: origin.id, posterId: alice.id, content: `fixes #${target.index}`, now: T0 });

    // Close actions only FROM pull requests — an issue comment carries none.
    expect((await xrefRowsFor(target.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
  });

  it("keeps a close keyword from a PR comment — the PR twins share the arm", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target", { posterId: alice.id });
    const pr = await seedPull(repoId, "the pull", alice.id);
    await service().addComment({ issueId: pr.id, posterId: alice.id, content: `fixes #${target.index}`, now: T0 });

    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(CommentType.CommentRef);
    expect(rows[0]?.refAction).toBe(RefAction.Closes);
    // ref_is_pull carries the COMMENTED issue's posture (a PR).
    expect(rows[0]?.refIsPull).toBe(true);
    expect(rows[0]?.refCommentId).not.toBeNull();
  });

  it("demotes a same-repo close from a non-writer non-poster comment doer (no merger exception for comments, :225-232)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    // The issue-BODY arm keeps this same shape (the merger exception, the
    // PR-create pin above); a COMMENT origin (OrigComment != nil) must hold
    // the write or the target's poster — bob has neither.
    await service().addComment({ issueId: origin.id, posterId: bob.id, content: `fixes #${target.index}`, now: T0 });

    expect((await xrefRowsFor(target.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
  });

  it("gates non-content-support types out (system comments scan nothing)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    await service().addComment({ issueId: origin.id, posterId: alice.id, content: `#${target.index}`, type: CommentType.Label, now: T0 });
    await service().addComment({ issueId: origin.id, posterId: alice.id, content: `#${target.index}`, type: CommentType.PullRequestPush, now: T0 });

    // HasContentSupport (comment.go:180-186) — types 0/21/22/32 only; the
    // type-4 commit-ref rows of the B-47 push walk gate out the same way
    // (the derived no-op recorded in the census).
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(0);
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
  });

  it("writes nothing for content without references", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const origin = await seedIssue(repoId, "origin");
    await service().addComment({ issueId: origin.id, posterId: alice.id, content: "no refs here", now: T0 });
    expect(await xrefRowsFrom(origin.id)).toHaveLength(0);
  });

  it("POST comments resolves AppURL-prefixed full URLs via the request origin", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");

    const res = await router()(`/repos/alice/visible/issues/${origin.index}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: `This is https://example.com/alice/visible/issues/${target.index}, foo` }),
    });
    expect(res.status).toBe(201);
    const created = await res.json<{ id: number }>();
    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(CommentType.CommentRef);
    expect(rows[0]?.refCommentId).toBe(created.id);
    expect(rows[0]?.posterId).toBe(1);
  });
});

describe("the comment edit arm — UpdateComment's tail (comment.go:1204)", () => {
  it("neuters removed references, keeps surviving pairs, writes fresh ones (removeOld=true)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const t1 = await seedIssue(repoId, "t1");
    const t2 = await seedIssue(repoId, "t2");
    const origin = await seedIssue(repoId, "origin");
    const comment = await service().addComment({
      issueId: origin.id,
      posterId: alice.id,
      content: `see #${t1.index}`,
      now: T0,
    });

    // Edit keeps the surviving reference and adds the fresh one — the
    // keep-fold consumes the (target, action) pair, no duplicate lands.
    await updateCommentBody(env.DB, comment.id, `see #${t1.index} and #${t2.index}`, T1, alice.id);
    const afterKeep = await xrefRowsFor(t1.id, origin.id);
    expect(afterKeep).toHaveLength(1);
    expect(afterKeep[0]?.refCommentId).toBe(comment.id);
    expect(afterKeep[0]?.createdAt?.getTime()).toBe(T0.getTime()); // the KEPT row is untouched
    expect((await xrefRowsFor(t2.id, origin.id)).map((r) => r.refCommentId)).toEqual([comment.id]);

    // Edit removing everything neuters the comment's rows — keyed on the
    // (origin issue, origin comment) pair.
    await updateCommentBody(env.DB, comment.id, "no more refs", T1, alice.id);
    expect((await xrefRowsFor(t1.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered]);
    expect((await xrefRowsFor(t2.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered]);
  });

  it("re-pairs an action change on a PR comment: the closes row neuters, a none row lands", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target", { posterId: alice.id });
    const pr = await seedPull(repoId, "the pull", alice.id);
    const comment = await service().addComment({ issueId: pr.id, posterId: alice.id, content: `fixes #${target.index}`, now: T0 });
    expect((await xrefRowsFor(target.id, pr.id)).map((r) => r.refAction)).toEqual([RefAction.Closes]);

    await updateCommentBody(env.DB, comment.id, `mentions #${target.index}`, T1, alice.id);
    const rows = await xrefRowsFor(target.id, pr.id);
    expect(rows.map((r) => r.refAction)).toEqual([RefAction.Neutered, RefAction.None]);
    expect(rows[1]?.refCommentId).toBe(comment.id);
  });

  it("a non-content-support type skips the scan (the gate lives inside the arm)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    // A type-4 commit_ref row is not content-supporting (comment.go:180-186)
    // — upstream's UpdateComment would scan nothing for it either.
    const inserted = await db()
      .insert(comments)
      .values({
        type: CommentType.CommitRef,
        posterId: alice.id,
        issueId: origin.id,
        content: `#${target.index}`,
        commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning()
      .all();
    const refRow = inserted[0];
    expect(refRow).toBeDefined();
    await updateCommentBody(env.DB, refRow!.id, `#${target.index} edited`, T1, alice.id);
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(0);
  });

  it("PATCH comments rescans through the request origin, with removeOld", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const t1 = await seedIssue(repoId, "t1");
    const t2 = await seedIssue(repoId, "t2");
    const origin = await seedIssue(repoId, "origin", { posterId: 1 }); // the stub may edit
    const comment = await service().addComment({
      issueId: origin.id,
      posterId: 1,
      content: `This is https://example.com/alice/visible/issues/${t1.index}, foo`,
      appUrl: "https://example.com", // the route's origin — full URLs scan only with it
      now: T0,
    });
    expect((await xrefRowsFor(t1.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);

    const res = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: `now #${t2.index}` }),
    });
    expect(res.status).toBe(200);
    // The URL reference neuters, the fresh short ref lands.
    expect((await xrefRowsFor(t1.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.Neutered]);
    expect((await xrefRowsFor(t2.id, origin.id)).map((r) => r.refAction)).toEqual([RefAction.None]);
  });
});

describe("the comment delete arm — DeleteComment's neuter (comment.go:1234)", () => {
  it("neuters the comment's active ref rows (the cascade runs by ref coordinates)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    const comment = await service().addComment({ issueId: origin.id, posterId: alice.id, content: `see #${target.index}`, now: T0 });
    expect(await xrefRowsFor(target.id, origin.id)).toHaveLength(1);

    const removed = await deleteComment(env.DB, comment, T1);
    expect(removed).toBe(true);
    // The rows sit ON the referenced issue and survive the origin comment's
    // hard delete — only ref_action moves (issue_xref.go:43-53).
    const rows = await xrefRowsFor(target.id, origin.id);
    expect(rows.map((r) => r.refAction)).toEqual([RefAction.Neutered]);
    expect(rows[0]?.refCommentId).toBe(comment.id);
    expect(rows[0]?.type).toBe(CommentType.CommentRef);
  });

  it("a sibling comment's rows survive; already-neutered rows stay neutered", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo("alice", "visible", { ownerId: alice.id });
    const target = await seedIssue(repoId, "target");
    const origin = await seedIssue(repoId, "origin");
    const first = await service().addComment({ issueId: origin.id, posterId: alice.id, content: `see #${target.index}`, now: T0 });
    const second = await service().addComment({ issueId: origin.id, posterId: alice.id, content: `also #${target.index}`, now: T0 });

    await deleteComment(env.DB, first, T1);
    const rows = await xrefRowsFor(target.id, origin.id);
    const byComment = new Map(rows.map((r) => [r.refCommentId, r.refAction]));
    expect(byComment.get(first.id)).toBe(RefAction.Neutered);
    expect(byComment.get(second.id)).toBe(RefAction.None);
  });
});
