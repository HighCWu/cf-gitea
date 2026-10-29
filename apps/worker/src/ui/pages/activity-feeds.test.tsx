/**
 * The activity feeds page module's tests (pages wave 50, the
 * `/{username}?tab=activity` module, MOUNTED at b1bf73a): the
 * type→icon/message matrix over fixture actions of each wired op type →
 * the DOM, plus the loader's service-parameter contract (profile.go:162-190's
 * arm) and the resolution seam. Real D1 via the vitest plugin (generated
 * migrations in beforeAll); the render runs through hono/jsx renderToString
 * — the render.test.tsx harness — with the loader driven directly (the
 * route arm is the module header's mount record — `index.ts`'s
 * `?tab=activity` dispatch).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { ActionType } from "../../api/services/activity-feeds";
import { users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  ACTIVITY_FEEDS_PAGE_SIZE,
  ActivityFeedList,
  ActivityFeedListItem,
  ActivityFeedsPage,
  activityFeedsLocale,
  ellipsisDisplay,
  feedBody,
  feedIconName,
  feedMessageSegments,
  issueIndexOf,
  issueInfos,
  loadActivityFeedsData,
  resolveActivityFeeds,
  type ActivityFeedItem,
  type ActivityFeedItemFields,
  type ActivityFeedsData,
} from "./activity-feeds";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const REPO_ID = "repo-alpha"; // deliberately NON-numeric — the Activity
// payload renders repo_id 0 for TEXT keys, so the issue-title join must go
// through the owner/slug coordinates (the loader's join note).
const PRIVATE_REPO_ID = "repo-private";
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };
const anonymousViewer: Viewer = { kind: "anonymous" };

const ctx: UiContext = {
  viewer: selfViewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let aliceId = 0;
let bobId = 0;
let issue7Id = 0;
let issue9Id = 0;
let comment7Id = 0;
let comment9Id = 0;

async function seedBaseFixtures(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  const bob = await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Banner', unixepoch())",
  ).run();
  bobId = bob.meta.last_row_id;
  aliceId = 1;

  for (const [id, slug, visibility] of [
    [REPO_ID, "demo", "public"],
    [PRIVATE_REPO_ID, "priv", "private"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, created_at) VALUES (?, ?, 'alice', 1, ?, ?, unixepoch())",
    )
      .bind(id, id, slug, visibility)
      .run();
  }

  const issue7 = await env.DB.prepare(
    "INSERT INTO issues (repo_id, `index`, poster_id, title, is_pull, created_unix) VALUES (?, 7, 2, 'Live issue title', 0, unixepoch())",
  )
    .bind(REPO_ID)
    .run();
  issue7Id = issue7.meta.last_row_id;
  const issue9 = await env.DB.prepare(
    "INSERT INTO issues (repo_id, `index`, poster_id, title, is_pull, created_unix) VALUES (?, 9, 2, 'The Pull', 1, unixepoch())",
  )
    .bind(REPO_ID)
    .run();
  issue9Id = issue9.meta.last_row_id;

  const comment7 = await env.DB.prepare(
    "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, 2, ?, 'A **comment** body', unixepoch())",
  )
    .bind(issue7Id)
    .run();
  comment7Id = comment7.meta.last_row_id;
  const comment9 = await env.DB.prepare(
    "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, 2, ?, 'PR remark', unixepoch())",
  )
    .bind(issue9Id)
    .run();
  comment9Id = comment9.meta.last_row_id;
}

interface ActionInsert {
  opType: number;
  content?: string;
  refName?: string;
  commentId?: number;
  repoId?: string;
  isPrivate?: boolean;
  actUserId?: number;
  userId?: number;
  createdAt?: number;
}

async function insertAction(insert: ActionInsert): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO action (user_id, op_type, act_user_id, repo_id, comment_id, is_deleted, ref_name, is_private, content, created_unix) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
  )
    .bind(
      insert.userId ?? aliceId,
      insert.opType,
      insert.actUserId ?? aliceId,
      insert.repoId ?? REPO_ID,
      insert.commentId ?? 0,
      insert.refName ?? "",
      insert.isPrivate === true ? 1 : 0,
      insert.content ?? "",
      insert.createdAt ?? T0,
    )
    .run();
}

/** One action row per wired op type (the SPEC §3.3 set plus the landed
 *  pulls/releases seams), receiver = actor = alice, newest last. */
async function seedAllWiredTypes(): Promise<void> {
  const rows: ActionInsert[] = [
    { opType: ActionType.CreateRepo, createdAt: T0 },
    { opType: ActionType.RenameRepo, content: "old-name", createdAt: T0 + 1 },
    { opType: ActionType.CreateIssue, content: "7|Stored excerpt title", createdAt: T0 + 2 },
    { opType: ActionType.CreatePullRequest, content: "9|PR title here", createdAt: T0 + 3 },
    {
      opType: ActionType.CommentIssue,
      content: "7|A **comment** body",
      commentId: comment7Id,
      createdAt: T0 + 4,
    },
    { opType: ActionType.MergePullRequest, content: "9|Merged PR title", createdAt: T0 + 5 },
    { opType: ActionType.CloseIssue, content: "7|", createdAt: T0 + 6 },
    { opType: ActionType.ReopenIssue, content: "7|", createdAt: T0 + 7 },
    { opType: ActionType.ClosePullRequest, content: "9|", createdAt: T0 + 8 },
    { opType: ActionType.ReopenPullRequest, content: "9|", createdAt: T0 + 9 },
    { opType: ActionType.ApprovePullRequest, content: "9|looks good", createdAt: T0 + 10 },
    { opType: ActionType.RejectPullRequest, content: "9|please change", createdAt: T0 + 11 },
    {
      opType: ActionType.CommentPull,
      content: "9|PR remark",
      commentId: comment9Id,
      createdAt: T0 + 12,
    },
    { opType: ActionType.PublishRelease, content: "v1 Release", refName: "refs/tags/v1", createdAt: T0 + 13 },
  ];
  for (const row of rows) await insertAction(row);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["action", "comments", "issues", "repositories", "users", "follows"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the pure matrix -----------------------------------------------------------

describe("the type→icon/message matrix (pure, per wired op type)", () => {
  const base: ActivityFeedItemFields = {
    id: 1,
    opType: "create_repo",
    actorName: "alice",
    actorTitle: "Alice Doe",
    actorHref: "/alice",
    repoHref: "/alice/demo",
    shortRepoPath: "alice/demo",
    createdUnix: T0,
    refName: "",
    content: "",
    issueIndex: 0,
    liveIssueTitle: "",
    liveCommentUrl: null,
  };
  const withOp = (opType: ActivityFeedItemFields["opType"], overrides: Partial<ActivityFeedItemFields> = {}): ActivityFeedItemFields => ({
    ...base,
    opType,
    ...overrides,
  });
  const link = (href: string, text: string) => ({ kind: "link", href, text });
  const text = (text: string) => ({ kind: "text", text });

  it("create_repo — octicon-repo, 'created repository <repo>', no body arm", () => {
    expect(feedIconName("create_repo")).toBe("octicon-repo"); // util_misc.go:74-76
    expect(feedMessageSegments(withOp("create_repo"))).toEqual([
      text("created repository "),
      link("/alice/demo", "alice/demo"),
    ]);
    expect(feedBody(withOp("create_repo"))).toBeNull();
  });

  it("rename_repo — octicon-repo, code-wrapped old name, no body arm", () => {
    expect(feedIconName("rename_repo")).toBe("octicon-repo"); // util_misc.go:74-76
    expect(feedMessageSegments(withOp("rename_repo", { content: "old-name" }))).toEqual([
      text("renamed repository from "),
      { kind: "code", text: "old-name" },
      text(" to "),
      link("/alice/demo", "alice/demo"),
    ]);
    expect(feedBody(withOp("rename_repo", { content: "old-name" }))).toBeNull();
  });

  it("create_issue — octicon-issue-opened, issues link, content-stored title span", () => {
    expect(feedIconName("create_issue")).toBe("octicon-issue-opened"); // util_misc.go:81
    expect(feedMessageSegments(withOp("create_issue", { content: "7|Stored excerpt title" }))).toEqual([
      text("opened issue "),
      link("/alice/demo/issues/7", "alice/demo#7"),
    ]);
    expect(feedBody(withOp("create_issue", { content: "7|Stored excerpt title" }))).toEqual({
      kind: "issue-title",
      title: "Stored excerpt title",
    });
  });

  it("create_pull_request — octicon-git-pull-request, pulls link, title span", () => {
    expect(feedIconName("create_pull_request")).toBe("octicon-git-pull-request"); // :82
    expect(feedMessageSegments(withOp("create_pull_request", { content: "9|PR title here" }))).toEqual([
      text("created pull request "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
    expect(feedBody(withOp("create_pull_request", { content: "9|PR title here" }))).toEqual({
      kind: "issue-title",
      title: "PR title here",
    });
  });

  it("comment_issue — comment-discussion (now exact), live-comment href + live title + excerpt", () => {
    expect(feedIconName("comment_issue")).toBe("octicon-comment-discussion"); // :85-86, the allowlist note
    expect(feedMessageSegments(withOp("comment_issue", { content: "7|A **comment** body" }))).toEqual([
      text("commented on issue "),
      link("/alice/demo/issues/7", "alice/demo#7"),
    ]);
    const body = feedBody(
      withOp("comment_issue", {
        content: "7|A **comment** body",
        issueIndex: 7,
        liveIssueTitle: "Live issue title",
        liveCommentUrl: `${ORIGIN}/alice/demo/issues/7#issuecomment-${comment7Id}`,
      }),
    );
    if (body === null || body.kind !== "comment") throw new Error("expected a comment body");
    expect(body.href).toBe(`${ORIGIN}/alice/demo/issues/7#issuecomment-${comment7Id}`);
    expect(body.title).toBe("Live issue title");
    expect(body.excerptHtml).toContain("<strong>comment</strong>");
  });

  it("merge_pull_request — octicon-git-merge, div.item-body arm with the content title", () => {
    expect(feedIconName("merge_pull_request")).toBe("octicon-git-merge"); // :83-84
    expect(feedMessageSegments(withOp("merge_pull_request", { content: "9|Merged PR title" }))).toEqual([
      text("merged pull request "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
    expect(feedBody(withOp("merge_pull_request", { content: "9|Merged PR title" }))).toEqual({
      kind: "merge-title",
      title: "Merged PR title",
    });
  });

  it("close_issue — octicon-issue-closed, live GetIssueTitle span", () => {
    expect(feedIconName("close_issue")).toBe("octicon-issue-closed"); // :87-88
    expect(feedMessageSegments(withOp("close_issue", { content: "7|" }))).toEqual([
      text("closed issue "),
      link("/alice/demo/issues/7", "alice/demo#7"),
    ]);
    expect(feedBody(withOp("close_issue", { content: "7|", liveIssueTitle: "Live issue title" }))).toEqual({
      kind: "issue-title",
      title: "Live issue title",
    });
  });

  it("reopen_issue — issue-reopened (now exact), live title span", () => {
    expect(feedIconName("reopen_issue")).toBe("octicon-issue-reopened"); // :89-90, the allowlist note
    expect(feedMessageSegments(withOp("reopen_issue", { content: "7|" }))).toEqual([
      text("reopened issue "),
      link("/alice/demo/issues/7", "alice/demo#7"),
    ]);
    expect(feedBody(withOp("reopen_issue", { content: "7|", liveIssueTitle: "Live issue title" }))).toEqual({
      kind: "issue-title",
      title: "Live issue title",
    });
  });

  it("close_pull_request — octicon-git-pull-request-closed, live PR title span", () => {
    expect(feedIconName("close_pull_request")).toBe("octicon-git-pull-request-closed"); // :79-80
    expect(feedMessageSegments(withOp("close_pull_request", { content: "9|" }))).toEqual([
      text("closed pull request "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
    expect(feedBody(withOp("close_pull_request", { content: "9|", liveIssueTitle: "The Pull" }))).toEqual({
      kind: "issue-title",
      title: "The Pull",
    });
  });

  it("reopen_pull_request — issue-opened (degradation), live PR title span", () => {
    expect(feedIconName("reopen_pull_request")).toBe("octicon-issue-reopened"); // :89-90
    expect(feedMessageSegments(withOp("reopen_pull_request", { content: "9|" }))).toEqual([
      text("reopened pull request "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
    expect(feedBody(withOp("reopen_pull_request", { content: "9|", liveIssueTitle: "The Pull" }))).toEqual({
      kind: "issue-title",
      title: "The Pull",
    });
  });

  it("approve_pull_request — octicon-check, 'approved', comment arm", () => {
    expect(feedIconName("approve_pull_request")).toBe("octicon-check"); // :91-92
    expect(feedMessageSegments(withOp("approve_pull_request", { content: "9|looks good" }))).toEqual([
      text("approved "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
    const approveBody = feedBody(
      withOp("approve_pull_request", { content: "9|looks good", issueIndex: 9, liveIssueTitle: "The Pull" }),
    );
    if (approveBody === null || approveBody.kind !== "comment") throw new Error("expected a comment body");
    expect(approveBody.href).toBe("/alice/demo/pulls/9"); // the Issue.Link fallback (no live comment)
    expect(approveBody.title).toBe("The Pull");
    expect(approveBody.excerptHtml).toContain("looks good");
  });

  it("reject_pull_request — file-diff (now exact), comment arm", () => {
    expect(feedIconName("reject_pull_request")).toBe("octicon-file-diff"); // :93-94, exact (allowlist +5)
    expect(feedMessageSegments(withOp("reject_pull_request", { content: "9|please change" }))).toEqual([
      text("suggested changes for "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
  });

  it("comment_pull — pencil, comment arm over the pulls fallback", () => {
    expect(feedIconName("comment_pull")).toBe("octicon-comment-discussion"); // :85-86
    expect(feedMessageSegments(withOp("comment_pull", { content: "9|PR remark" }))).toEqual([
      text("commented on pull request "),
      link("/alice/demo/pulls/9", "alice/demo#9"),
    ]);
    const pullBody = feedBody(
      withOp("comment_pull", { content: "9|PR remark", issueIndex: 9, liveIssueTitle: "The Pull" }),
    );
    if (pullBody === null || pullBody.kind !== "comment") throw new Error("expected a comment body");
    expect(pullBody.href).toBe("/alice/demo/pulls/9");
    expect(pullBody.title).toBe("The Pull");
    expect(pullBody.excerptHtml).toContain("PR remark");
  });

  it("publish_release — octicon-tag, tag link from ref_name with the release-name text", () => {
    expect(feedIconName("publish_release")).toBe("octicon-tag"); // :95-96
    expect(
      feedMessageSegments(withOp("publish_release", { content: "v1 Release", refName: "refs/tags/v1" })),
    ).toEqual([
      text("released "),
      link("/alice/demo/releases/tag/v1", "v1 Release"),
      text(" at "),
      link("/alice/demo", "alice/demo"),
    ]);
    expect(feedBody(withOp("publish_release", { content: "v1 Release", refName: "refs/tags/v1" }))).toBeNull();
  });

  it("types outside the wired set degrade exactly like upstream's fall-through", () => {
    // commit_repo is a known upstream type with NO landed producer — the
    // honest arm is the default icon and no message/body (feeds.tmpl's
    // if-chain has no default branch).
    expect(feedIconName("commit_repo")).toBe("octicon-question"); // :107-108, the exact default
    expect(feedMessageSegments(withOp("commit_repo"))).toBeNull();
    expect(feedBody(withOp("commit_repo"))).toBeNull();
  });

  it("GetCommentLink's missing-issue arm renders '#'", () => {
    const body = feedBody(withOp("comment_issue", { content: "999|orphan", issueIndex: 999, liveIssueTitle: "<500 when get issue>" }));
    expect(body).toMatchObject({ kind: "comment", href: "#" });
  });
});

// --- template-helper primitives -------------------------------------------------

describe("the Actioner primitive ports", () => {
  it("issueInfos splits like Go's strings.SplitN(content, \"|\", 3)", () => {
    expect(issueInfos("1|a|b|c")).toEqual(["1", "a", "b|c"]); // the remainder stays in element 3
    expect(issueInfos("1|excerpt")).toEqual(["1", "excerpt", ""]);
    expect(issueInfos("12|")).toEqual(["12", "", ""]);
    expect(issueInfos("plain")).toEqual(["plain", "", ""]);
  });

  it("issueIndexOf parses infos[0] like strconv.ParseInt (junk → 0)", () => {
    expect(issueIndexOf("7|x")).toBe(7);
    expect(issueIndexOf("007|x")).toBe(7);
    expect(issueIndexOf("7x|x")).toBe(0);
    expect(issueIndexOf("|x")).toBe(0);
    expect(issueIndexOf("-1|x")).toBe(0);
  });

  it("ellipsisDisplay trims to the limit with the ellipsis (the ShortRepoPath trim)", () => {
    expect(ellipsisDisplay("alice", 20)).toBe("alice");
    expect(ellipsisDisplay("a".repeat(21), 20)).toBe(`${"a".repeat(19)}…`);
    expect(ellipsisDisplay("a".repeat(20), 20)).toBe("a".repeat(20));
    expect(Array.from(ellipsisDisplay("絵文字".repeat(30), 20))).toHaveLength(20); // code points, not bytes
  });
});

// --- the loader over the landed service -----------------------------------------

describe("loadActivityFeedsData (profile.go:162-190's arm)", () => {
  it("renders one feed item per wired op type with the feeds.tmpl DOM", async () => {
    await seedBaseFixtures();
    await seedAllWiredTypes();

    const data = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    // 14 wired rows + the private-repo row the seeded set does not include —
    // onlyPerformedBy (profile.go:172) keeps the performer's own rows.
    expect(data.items).toHaveLength(14);
    expect(data.total).toBe(14);
    expect(data.more).toBe(false);

    const html = renderToString(
      <ActivityFeedListForTest items={data.items} />,
    );
    // The container (feeds.tmpl:1).
    expect(html).toContain('id="activity-feed"');
    expect(html).toContain("data-ref-issue-container");
    // The actor link: username text, full-name tooltip
    // (GetActDisplayName / GetActDisplayNameTitle).
    expect(html).toContain('<a href="/alice" title="Alice Doe">alice</a>');
    // The repo link + the issue links (PathEscape'd segments).
    expect(html).toContain('href="/alice/demo"');
    expect(html).toContain('href="/alice/demo/issues/7"');
    expect(html).toContain("alice/demo#7");
    expect(html).toContain('href="/alice/demo/pulls/9"');
    // The live GetIssueTitle span arms.
    expect(html).toContain('class="tw-inline-block tw-truncate issue title"');
    expect(html).toContain("Live issue title");
    expect(html).toContain("The Pull");
    // The merge arm's div.item-body.
    expect(html).toContain('class="item-body tw-text-text"');
    expect(html).toContain("Merged PR title");
    // The comment excerpt through the markdown service.
    expect(html).toContain('class="render-content markup"');
    expect(html).toContain("<strong>comment</strong>");
    // The release arm's tag link.
    expect(html).toContain('href="/alice/demo/releases/tag/v1"');
    expect(html).toContain("v1 Release");
    // The trailing 32px action glyphs (ActionIcon over the wired set).
    expect(html).toContain("octicon-repo tw-text-text-light tw-mr-1");
    expect(html).toContain("octicon-git-merge tw-text-text-light tw-mr-1");
    expect(html).toContain("octicon-issue-closed tw-text-text-light tw-mr-1");
    expect(html).toContain("octicon-check tw-text-text-light tw-mr-1");
    expect(html).toContain("octicon-tag tw-text-text-light tw-mr-1");
    expect(html).toContain("octicon-comment-discussion tw-text-text-light tw-mr-1");
    // TimeSince (DateUtils.TimeSince).
    expect(html).toContain("<relative-time");
  });

  it("orders items newest-first and resolves the item projection fields", async () => {
    await seedBaseFixtures();
    await seedAllWiredTypes();

    const data = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    expect(data.items[0]?.opType).toBe("publish_release"); // created T0+13, the DESC order
    expect(data.items.at(-1)?.opType).toBe("create_repo");
    const commentItem = data.items.find((item) => item.opType === "comment_issue");
    expect(commentItem).toMatchObject({
      actorName: "alice",
      actorTitle: "Alice Doe",
      actorHref: "/alice",
      repoHref: "/alice/demo",
      shortRepoPath: "alice/demo",
      issueIndex: 7,
      liveIssueTitle: "Live issue title",
    });
    expect(commentItem?.liveCommentUrl).toContain(`/issues/7#issuecomment-${comment7Id}`);
    expect(commentItem?.icon).toBe("octicon-comment-discussion");
    const closeItem = data.items.find((item) => item.opType === "close_issue");
    expect(closeItem?.liveIssueTitle).toBe("Live issue title");
  });

  it("onlyPerformedBy=true drops receiver rows another user acted on", async () => {
    await seedBaseFixtures();
    await insertAction({ opType: ActionType.CreateIssue, content: "7|by alice" });
    // A watcher-style receiver row: alice receives, bob performed.
    await insertAction({ opType: ActionType.CreateIssue, content: "7|by bob", actUserId: bobId });

    const data = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.content).toBe("7|by alice");
  });

  it("the self viewer sees private-repo actions; an anonymous viewer does not", async () => {
    await seedBaseFixtures();
    await insertAction({ opType: ActionType.CreateIssue, content: "1|public work" });
    await insertAction({
      opType: ActionType.CreateIssue,
      content: "1|secret work",
      repoId: PRIVATE_REPO_ID,
      isPrivate: true,
    });

    const self = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    expect(self.items).toHaveLength(2); // includePrivate = self (profile.go:171)

    const anon = await loadActivityFeedsData(env.DB, await userRow("alice"), anonymousViewer, ORIGIN, new URLSearchParams());
    expect(anon.items).toHaveLength(1);
    expect(anon.items[0]?.content).toBe("1|public work");
  });

  it("the keep_activity_private info-message flag follows the owner's visibility", async () => {
    await seedBaseFixtures();
    const alice = await userRow("alice");
    const data = await loadActivityFeedsData(env.DB, alice, selfViewer, ORIGIN, new URLSearchParams());
    expect(data.keepActivityPrivate).toBe(false);

    await env.DB.prepare("UPDATE users SET visibility = 'private' WHERE id = 1").run();
    const privated = await loadActivityFeedsData(
      env.DB,
      await userRow("alice"),
      selfViewer,
      ORIGIN,
      new URLSearchParams(),
    );
    expect(privated.keepActivityPrivate).toBe(true);
    expect(renderToString(<ActivityFeedsPageForTest data={privated} ctx={ctx} />)).toContain(
      activityFeedsLocale.disabled_public_activity,
    );
  });

  it("paginates at FeedPagingNum (20) with the Older/Newer pair carrying tab+page", async () => {
    await seedBaseFixtures();
    for (let i = 0; i < ACTIVITY_FEEDS_PAGE_SIZE + 1; i++) {
      await insertAction({ opType: ActionType.CreateIssue, content: `${i + 1}|row`, createdAt: T0 + i });
    }
    const data = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    expect(data.items).toHaveLength(ACTIVITY_FEEDS_PAGE_SIZE);
    expect(data.total).toBe(ACTIVITY_FEEDS_PAGE_SIZE + 1);
    expect(data.more).toBe(true);

    const pageTwo = new URLSearchParams({ page: "2" });
    const second = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, pageTwo);
    expect(second.items).toHaveLength(1);
    expect(second.more).toBe(false);
    // Page 2 renders the Newer link back to the unparameterized page (the
    // OrgHomePagination shape — page 1 omits the param, QueryBuild style).
    const html = renderToString(<ActivityFeedsPageForTest data={second} ctx={ctx} />);
    expect(html).toContain(`href="/alice?tab=activity"`);
    expect(html).toContain("Newer");
    expect(html).not.toContain("page=1");
  });

  it("passes the date window through to the service (UTC day)", async () => {
    await seedBaseFixtures();
    await insertAction({ opType: ActionType.CreateIssue, content: "1|in window", createdAt: T0 });
    await insertAction({
      opType: ActionType.CreateIssue,
      content: "2|outside",
      createdAt: T0 + 2 * 86_400,
    });

    const data = await loadActivityFeedsData(
      env.DB,
      await userRow("alice"),
      selfViewer,
      ORIGIN,
      new URLSearchParams({ date: "2023-11-14" }),
    );
    expect(data.total).toBe(1);
    expect(data.items[0]?.content).toBe("1|in window");
    expect(data.date).toBe("2023-11-14");
  });

  it("degrades a comment arm whose issue row vanished to the upstream literal", async () => {
    await seedBaseFixtures();
    // content "999|orphan" points at an issue index with no row — the
    // GetIssueTitle load-error literal (action.go:394-403).
    await insertAction({ opType: ActionType.CommentIssue, content: "999|orphan" });
    const data = await loadActivityFeedsData(env.DB, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    const orphan = data.items[0];
    if (orphan === undefined) throw new Error("expected the orphan comment item");
    expect(orphan.liveIssueTitle).toBe("<500 when get issue>");
    // The literal renders (upstream escapes it the same way through
    // RenderIssueSimpleTitle — a plain string into an escaped context).
    expect(renderToString(<ActivityFeedListItem item={orphan} />)).toContain("&lt;500 when get issue&gt;");
    expect(renderToString(<ActivityFeedListItem item={orphan} />)).toContain('href="#"');
  });
});

// --- the query-shape witness (query-shape-audit C2) ------------------------------

// The loader's live-title read used to select EVERY issue of the referenced
// repos (`inArray(issues.repoId, ...)`, post-filtered in memory) — hundreds
// of rows read to title ≤ page size on a grown corpus. It now consolidates
// onto the service's `feedIssueTitles`, whose select filters BOTH columns
// through the (repo_id, index) unique index. Metered the
// api/routes/activity-feeds.test.ts A8 witness way (prepare-counting
// wrapper), extended with bench-d1.test.ts's rows_read protocol: drizzle's
// mapped SELECT path executes through raw(), which drops the D1Result meta,
// so raw()-routed statements are recorded and replayed untimed after the
// load — the loader is read-only, so the replay reports the same rows_read.

/** Corpus size the witness grows repo-alpha to (indexes 1..45; the base
 *  fixtures' 7 and 9 ride inside the range). The pre-fix read drew all of
 *  these rows to title 2 indexes. */
const C2_CORPUS_ISSUES = 45;

interface CountedD1 {
  db: D1Database;
  /** prepare() calls — every drizzle statement enters through one. */
  count: () => number;
  /** The SQL strings seen at prepare() (the actual statements the loader
   *  issued). */
  queries: () => string[];
  /** Summed rows_read of the raw()-routed statements matching `match`,
   *  via the untimed replay (see the block comment). */
  rowsReadOf: (match: (sql: string) => boolean) => Promise<number>;
}

function countedD1(): CountedD1 {
  let statements = 0;
  const seen: string[] = [];
  const pendingRaw: { sql: string; stmt: D1PreparedStatement }[] = [];
  const wrapStmt = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => wrapStmt(target.bind(...args), sql);
        }
        if (prop === "raw") {
          return () => {
            pendingRaw.push({ sql, stmt: target });
            return target.raw();
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return proxy;
  };
  const wrapper = Object.create(env.DB) as D1Database;
  wrapper.prepare = (query: string) => {
    statements += 1;
    seen.push(query);
    return wrapStmt(env.DB.prepare(query), query);
  };
  return {
    db: wrapper,
    count: () => statements,
    queries: () => seen,
    rowsReadOf: async (match) => {
      let rows = 0;
      for (const pending of pendingRaw.splice(0)) {
        if (!match(pending.sql)) continue;
        const result = await pending.stmt.all();
        rows += result.meta?.rows_read ?? 0;
      }
      return rows;
    },
  };
}

describe("activity feeds query-shape witness (query-shape-audit C2)", () => {
  it("the live-title read probes the referenced pairs, not every issue of the referenced repos", async () => {
    await seedBaseFixtures();
    // Grow repo-alpha's corpus around the fixtures' issues 7 and 9.
    for (const index of Array.from({ length: C2_CORPUS_ISSUES }, (_, i) => i + 1)) {
      if (index === 7 || index === 9) continue;
      await env.DB.prepare(
        "INSERT INTO issues (repo_id, `index`, poster_id, title, is_pull, created_unix) VALUES (?, ?, 2, ?, 0, unixepoch())",
      )
        .bind(REPO_ID, index, `Corpus issue ${index}`)
        .run();
    }
    // The page's live-title arms reference exactly two (repoId, index) pairs.
    await insertAction({ opType: ActionType.CloseIssue, content: "7|" });
    await insertAction({ opType: ActionType.ClosePullRequest, content: "9|" });

    const meter = countedD1();
    const data = await loadActivityFeedsData(meter.db, await userRow("alice"), selfViewer, ORIGIN, new URLSearchParams());
    // Contract unchanged: both live titles still resolve through the
    // coordinates join, every unreferenced corpus row stays unread.
    expect(data.items.map((item) => item.liveIssueTitle).sort()).toEqual(["Live issue title", "The Pull"]);

    // (a) Statement count fixed at the documented arms — 2 (page + count)
    // + 2 (act users + repo pairs) + 1 (coordinates) + 1 (titles) + 1
    // (badge count) + 4 (follow count+page ×2) = 11, corpus-independent.
    expect(meter.count()).toBeLessThanOrEqual(11);

    // (b) The loader's ACTUAL title statement carries BOTH filters — a
    // revert to the repo-only select fails this pin (and no other loader
    // statement filters on repo_id: this match is unique to the title read).
    const titleSql = meter.queries().find((sql) => sql.includes('"repo_id" in'));
    expect(titleSql, "the loader must issue the batched title read").toBeDefined();
    expect(titleSql).toMatch(/"index" in/);

    // (c) The cost anchor, side by side on the same corpus: the loader's
    // replayed title statement reads the referenced pairs only — strictly
    // under the corpus — while the pre-fix repo-only shape (raw statement,
    // meta carried directly) reads every corpus row.
    const fixedRead = await meter.rowsReadOf((sql) => sql.includes('"repo_id" in'));
    expect(fixedRead).toBeGreaterThan(0);
    expect(fixedRead).toBeLessThan(C2_CORPUS_ISSUES);
    const preFix = await env.DB.prepare('SELECT "repo_id", "index", "title" FROM "issues" WHERE "repo_id" IN (?)')
      .bind(REPO_ID)
      .all();
    const preFixRead = preFix.meta?.rows_read ?? 0;
    expect(preFixRead).toBeGreaterThanOrEqual(C2_CORPUS_ISSUES);
    expect(fixedRead).toBeLessThan(preFixRead);
  });
});

// --- the resolution seam ---------------------------------------------------------

describe("resolveActivityFeeds (the OwnerProfile dispatch seam)", () => {
  it("resolves a user name to the user arm and an unknown name to missing", async () => {
    await seedBaseFixtures();
    const user = await resolveActivityFeeds(env.DB, "alice", { id: null, isAdmin: false }, "/", "");
    if (user.kind !== "user") throw new Error("expected the user arm");
    expect(user.user.username).toBe("alice");

    const missing = await resolveActivityFeeds(env.DB, "nobody", { id: null, isAdmin: false }, "/", "");
    expect(missing).toEqual({ kind: "missing" });
  });

  it("resolves an org name to the org arm (org.Home ignores tab=activity upstream)", async () => {
    await seedBaseFixtures();
    await env.DB.prepare(
      "INSERT INTO users (username, username_lower, type, created_at) VALUES ('myorg', 'myorg', 'org', unixepoch())",
    ).run();
    const org = await resolveActivityFeeds(env.DB, "myorg", { id: null, isAdmin: false }, "/", "");
    if (org.kind !== "org") throw new Error("expected the org arm");
    expect(org.org.username).toBe("myorg");
  });
});

// --- helpers --------------------------------------------------------------------

async function userRow(name: string): Promise<typeof users.$inferSelect> {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, name)).get();
  if (row === undefined) throw new Error(`fixture user ${name} missing`);
  return row;
}

/** The list alone (the feeds.tmpl fragment) for DOM-focused assertions. */
function ActivityFeedListForTest(props: { items: ActivityFeedItem[] }) {
  return <ActivityFeedList items={props.items} />;
}

/** The full page for chrome assertions. */
function ActivityFeedsPageForTest(props: { data: ActivityFeedsData; ctx: UiContext }) {
  return <ActivityFeedsPage ctx={props.ctx} data={props.data} />;
}
