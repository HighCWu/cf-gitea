/**
 * The profile ACTIVITY tab's DEFERRED matrix (the polish wave for the wave-50
 * module, committed ec07fb6) — driven through the page module's seams on the
 * module suite's real-D1 harness.
 *
 * ## MOUNT VERDICT (verified before writing a line; updated by the mount
 * window)
 *
 * The `?tab=activity` arm is MOUNTED since this repo's dispatch window:
 * `ownerHomePage`'s user arm reads the tab param and dispatches to
 * `loadActivityFeedsData` + `renderActivityFeedsPage` (the HANDOFF NOTE's
 * resolve → load → render path, exactly the seams this matrix drives); the
 * route-level arms — org-half ignorance, the visibility ladder, the strip
 * anchors on both pages — are pinned by pages/user-profile.matrix.test.ts
 * (re-armed with the mount). This file therefore keeps targeting the module
 * seams (the same calls the route arm makes).
 *
 * ## Scope — the arms the neighbors do NOT own
 *
 * pages/activity-feeds.test.tsx owns the PURE per-type matrix (fixture
 * `ActivityFeedItemFields` → icon/message/body functions), the template
 * primitives, the loader's service-parameter contract (onlyPerformedBy, the
 * self/anonymous pair, the date window, the orphan literal) and the bare
 * resolution seam. This file adds the deferred arms around it:
 *
 *   - the GATES: the loader's full viewer ladder — signed-in stranger, site
 *     admin (the service's self-or-admin fast path), the keep_activity_private
 *     owner (users.visibility = 'private' empties the feed behind the
 *     act-user condition, action.go:473-497 — the data gate behind the info
 *     message) and the unconditional is_deleted filter;
 *   - the 14 wired op types through the LOADER (real `action` rows → the
 *     per-item projection: op_type wire name, icon, message segments, body
 *     arm, live title/comment resolution) — the pure matrix's complement,
 *     plus the unproduced-type fall-through over REAL data;
 *   - the PAGINATION matrix: the Older/Newer pair's four shapes (first with
 *     more, middle, last, beyond-range), the junk/zero page params riding
 *     parsePageNumber, the date carried through the pager hrefs, the empty
 *     feed's container-only render;
 *   - the CROSS-SCOPE resolution gates (org vs user): the org arm under the
 *     tab query, renamed org vs renamed user redirects (query preserved, the
 *     org half's type gate never leaking a user-target redirect), the
 *     invisible org folding into missing for anonymous but not for a member,
 *     the private-visibility user's IsFollowing arm, the prohibited-user
 *     status gate.
 *
 * Real D1 via the vitest plugin (per-test storage isolation); the render
 * runs through hono/jsx renderToString — the module suite's harness.
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
  ActivityFeedsPage,
  activityFeedsLocale,
  loadActivityFeedsData,
  resolveActivityFeeds,
  type ActivityFeedItem,
  type ActivityFeedsData,
  type FeedMessageSegment,
} from "./activity-feeds";

// --- fixtures -----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const REPO_ID = "repo-alpha"; // deliberately NON-numeric — the TEXT-key join
const PRIVATE_REPO_ID = "repo-private";
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const ctx: UiContext = {
  viewer: { kind: "user", id: 1, username: "alice", isAdmin: false },
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let aliceId = 0;
let bobId = 0;
let rootId = 0;
let issue7Id = 0;
let issue9Id = 0;
let comment7Id = 0;
let comment9Id = 0;

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };
const strangerViewer: Viewer = { kind: "user", id: 2, username: "bob", isAdmin: false };
const adminViewer: Viewer = { kind: "user", id: 3, username: "root", isAdmin: true };
const anonymousViewer: Viewer = { kind: "anonymous" };

async function seedBaseFixtures(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Banner', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, created_at) VALUES (3, 'root', 'root', 1, unixepoch())",
  ).run();
  aliceId = 1;
  bobId = 2;
  rootId = 3;

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
  isDeleted?: boolean;
  actUserId?: number;
  userId?: number;
  createdAt?: number;
}

async function insertAction(insert: ActionInsert): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO action (user_id, op_type, act_user_id, repo_id, comment_id, is_deleted, ref_name, is_private, content, created_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      insert.userId ?? aliceId,
      insert.opType,
      insert.actUserId ?? aliceId,
      insert.repoId ?? REPO_ID,
      insert.commentId ?? 0,
      insert.isDeleted === true ? 1 : 0,
      insert.refName ?? "",
      insert.isPrivate === true ? 1 : 0,
      insert.content ?? "",
      insert.createdAt ?? T0,
    )
    .run();
}

/** A public-repo + private-repo action pair from alice (the visibility
 *  fixtures every gate test rides). */
async function seedVisibilityPair(): Promise<void> {
  await insertAction({ opType: ActionType.CreateIssue, content: "1|public work", createdAt: T0 });
  await insertAction({
    opType: ActionType.CreateIssue,
    content: "2|secret work",
    repoId: PRIVATE_REPO_ID,
    isPrivate: true,
    createdAt: T0 + 1,
  });
}

async function userRow(name: string): Promise<typeof users.$inferSelect> {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, name)).get();
  if (row === undefined) throw new Error(`fixture user ${name} missing`);
  return row;
}

async function load(
  viewer: Viewer,
  params: URLSearchParams = new URLSearchParams(),
): Promise<ActivityFeedsData> {
  return loadActivityFeedsData(env.DB, await userRow("alice"), viewer, ORIGIN, params);
}

function renderPage(data: ActivityFeedsData): string {
  return renderToString(<ActivityFeedsPage ctx={ctx} data={data} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "action",
    "comments",
    "issues",
    "repositories",
    "users",
    "follows",
    "user_redirects",
    "org_members",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the gates: the loader's full viewer ladder ----------------------------------

describe("the gates (the loader's viewer ladder beyond the module suite's self/anon pair)", () => {
  it("a signed-in stranger sees only the public rows; the Repositories badge follows the same gate", async () => {
    await seedBaseFixtures();
    await seedVisibilityPair();

    const stranger = await load(strangerViewer);
    expect(stranger.items).toHaveLength(1); // includePrivate = self/admin only (profile.go:171)
    expect(stranger.items[0]?.content).toBe("1|public work");
    expect(stranger.repoCount).toBe(1); // the badge: public-only WHERE

    const self = await load(selfViewer);
    expect(self.items).toHaveLength(2);
    expect(self.repoCount).toBe(2); // the owner counts both
  });

  it("a site admin rides the service's self-or-admin fast path: private rows render, the badge counts both", async () => {
    await seedBaseFixtures();
    await seedVisibilityPair();

    const admin = await load(adminViewer);
    expect(admin.items).toHaveLength(2); // isSelfOrAdmin skips both visibility filters (action_list.go:215)
    expect(admin.items.map((item) => item.content).sort()).toEqual(["1|public work", "2|secret work"]);
    expect(admin.repoCount).toBe(2);
  });

  it("keep_activity_private empties the feed behind the act-user gate — stranger and anonymous see nothing, self and admin everything", async () => {
    await seedBaseFixtures();
    await seedVisibilityPair();
    await env.DB.prepare("UPDATE users SET visibility = 'private' WHERE id = 1").run();

    // The route would 404 a stranger on a private-visibility user first
    // (the resolution ladder); the loader's act-user condition
    // (action.go:473-497) is the data path's own defense — alice is not in
    // the public/limited set, so only the fast path sees her rows.
    const anon = await load(anonymousViewer);
    const stranger = await load(strangerViewer);
    const self = await load(selfViewer);
    const admin = await load(adminViewer);
    expect(anon.items).toHaveLength(0);
    expect(stranger.items).toHaveLength(0);
    expect(self.items).toHaveLength(2);
    expect(admin.items).toHaveLength(2);
    for (const data of [anon, stranger, self, admin]) {
      expect(data.keepActivityPrivate).toBe(true); // viewer-independent (profile.tmpl:11-15)
    }
  });

  it("the info message renders for a stranger's load too (the flag is viewer-independent)", async () => {
    await seedBaseFixtures();
    await seedVisibilityPair();
    await env.DB.prepare("UPDATE users SET visibility = 'private' WHERE id = 1").run();

    const html = renderPage(await load(strangerViewer));
    expect(html).toContain(activityFeedsLocale.disabled_public_activity);
  });

  it("soft-deleted rows never render, even to the owner (the unconditional is_deleted filter)", async () => {
    await seedBaseFixtures();
    await insertAction({ opType: ActionType.CreateIssue, content: "1|live" });
    await insertAction({ opType: ActionType.CreateIssue, content: "2|deleted", isDeleted: true, createdAt: T0 + 1 });

    const data = await load(selfViewer);
    expect(data.total).toBe(1);
    expect(data.items.map((item) => item.content)).toEqual(["1|live"]);
  });
});

// --- the 14 wired op types through the loader ------------------------------------

/** The segment builders (the module suite's shape — plain objects). */
const seg = {
  text: (text: string): FeedMessageSegment => ({ kind: "text", text }),
  link: (href: string, text: string): FeedMessageSegment => ({ kind: "link", href, text }),
  code: (text: string): FeedMessageSegment => ({ kind: "code", text }),
};

interface MatrixRow {
  name: string;
  opType: string; // the wire name the loader must project
  insert: ActionInsert;
  icon: string;
  message: FeedMessageSegment[] | null;
  checkBody: (item: ActivityFeedItem) => void;
}

const LIVE_PULL_BODY =
  (href: string, excerpt: string): ((item: ActivityFeedItem) => void) =>
  (item) => {
    expect(item.body).toMatchObject({ kind: "comment", href, title: "The Pull" });
    if (item.body?.kind !== "comment") throw new Error("expected a comment body");
    expect(item.body.excerptHtml).toContain(excerpt);
  };

const LOADER_MATRIX: MatrixRow[] = [
  {
    name: "create_repo — octicon-repo, 'created repository', no body",
    opType: "create_repo",
    insert: { opType: ActionType.CreateRepo },
    icon: "octicon-repo",
    message: [seg.text("created repository "), seg.link("/alice/demo", "alice/demo")],
    checkBody: (item) => expect(item.body).toBeNull(),
  },
  {
    name: "rename_repo — the old name rides as the code segment",
    opType: "rename_repo",
    insert: { opType: ActionType.RenameRepo, content: "old-name" },
    icon: "octicon-repo",
    message: [seg.text("renamed repository from "), seg.code("old-name"), seg.text(" to "), seg.link("/alice/demo", "alice/demo")],
    checkBody: (item) => expect(item.body).toBeNull(),
  },
  {
    name: "create_issue — the content-stored title spans the body arm",
    opType: "create_issue",
    insert: { opType: ActionType.CreateIssue, content: "7|Stored excerpt title" },
    icon: "octicon-issue-opened",
    message: [seg.text("opened issue "), seg.link("/alice/demo/issues/7", "alice/demo#7")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "issue-title", title: "Stored excerpt title" }),
  },
  {
    name: "create_pull_request — the pulls link and the stored title",
    opType: "create_pull_request",
    insert: { opType: ActionType.CreatePullRequest, content: "9|PR title here" },
    icon: "octicon-git-pull-request",
    message: [seg.text("created pull request "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "issue-title", title: "PR title here" }),
  },
  {
    name: "comment_issue — the live comment's html_url wins the anchor, the live title + excerpt render",
    opType: "comment_issue",
    insert: { opType: ActionType.CommentIssue, content: "7|A **comment** body" },
    icon: "octicon-comment-discussion",
    message: [seg.text("commented on issue "), seg.link("/alice/demo/issues/7", "alice/demo#7")],
    checkBody: (item) => {
      expect(item.liveCommentUrl).toContain(`/issues/7#issuecomment-${comment7Id}`);
      expect(item.body).toMatchObject({
        kind: "comment",
        href: item.liveCommentUrl, // GetCommentLink's Comment.Link arm (action.go:317-338)
        title: "Live issue title",
      });
      if (item.body?.kind !== "comment") throw new Error("expected a comment body");
      expect(item.body.excerptHtml).toContain("<strong>comment</strong>");
    },
  },
  {
    name: "merge_pull_request — the div.item-body arm carries the content title",
    opType: "merge_pull_request",
    insert: { opType: ActionType.MergePullRequest, content: "9|Merged PR title" },
    icon: "octicon-git-merge",
    message: [seg.text("merged pull request "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "merge-title", title: "Merged PR title" }),
  },
  {
    name: "close_issue — the live GetIssueTitle through the TEXT-key coordinate join",
    opType: "close_issue",
    insert: { opType: ActionType.CloseIssue, content: "7|" },
    icon: "octicon-issue-closed",
    message: [seg.text("closed issue "), seg.link("/alice/demo/issues/7", "alice/demo#7")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "issue-title", title: "Live issue title" }),
  },
  {
    name: "reopen_issue — the live title, the issue-reopened glyph",
    opType: "reopen_issue",
    insert: { opType: ActionType.ReopenIssue, content: "7|" },
    icon: "octicon-issue-reopened",
    message: [seg.text("reopened issue "), seg.link("/alice/demo/issues/7", "alice/demo#7")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "issue-title", title: "Live issue title" }),
  },
  {
    name: "close_pull_request — the live PR title, the closed glyph",
    opType: "close_pull_request",
    insert: { opType: ActionType.ClosePullRequest, content: "9|" },
    icon: "octicon-git-pull-request-closed",
    message: [seg.text("closed pull request "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "issue-title", title: "The Pull" }),
  },
  {
    name: "reopen_pull_request — the live PR title",
    opType: "reopen_pull_request",
    insert: { opType: ActionType.ReopenPullRequest, content: "9|" },
    icon: "octicon-issue-reopened",
    message: [seg.text("reopened pull request "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: (item) => expect(item.body).toEqual({ kind: "issue-title", title: "The Pull" }),
  },
  {
    name: "approve_pull_request — the Issue.Link fallback anchor (no live comment)",
    opType: "approve_pull_request",
    insert: { opType: ActionType.ApprovePullRequest, content: "9|looks good" },
    icon: "octicon-check",
    message: [seg.text("approved "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: LIVE_PULL_BODY("/alice/demo/pulls/9", "looks good"),
  },
  {
    name: "reject_pull_request — 'suggested changes for', the Issue.Link fallback",
    opType: "reject_pull_request",
    insert: { opType: ActionType.RejectPullRequest, content: "9|please change" },
    icon: "octicon-file-diff",
    message: [seg.text("suggested changes for "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: LIVE_PULL_BODY("/alice/demo/pulls/9", "please change"),
  },
  {
    name: "comment_pull — the live comment anchor over the pulls fallback",
    opType: "comment_pull",
    insert: { opType: ActionType.CommentPull, content: "9|PR remark" },
    icon: "octicon-comment-discussion",
    message: [seg.text("commented on pull request "), seg.link("/alice/demo/pulls/9", "alice/demo#9")],
    checkBody: (item) => {
      // FIXED (the escalated divergence, closed in the folds follow-up):
      // commentHtmlUrl now branches on is_pull (upstream
      // Comment.HTMLURL → Issue.HTMLURL, models/issues/issue.go:386-394 —
      // path "pulls"), so the served liveCommentUrl anchors under
      // /pulls/9 exactly like upstream.
      expect(item.liveCommentUrl).toContain(`/pulls/9#issuecomment-${comment9Id}`);
      expect(item.body).toMatchObject({ kind: "comment", href: item.liveCommentUrl, title: "The Pull" });
    },
  },
  {
    name: "publish_release — the tag link strips the refs/tags prefix",
    opType: "publish_release",
    insert: { opType: ActionType.PublishRelease, content: "v1 Release", refName: "refs/tags/v1" },
    icon: "octicon-tag",
    message: [
      seg.text("released "),
      seg.link("/alice/demo/releases/tag/v1", "v1 Release"),
      seg.text(" at "),
      seg.link("/alice/demo", "alice/demo"),
    ],
    checkBody: (item) => expect(item.body).toBeNull(),
  },
];

describe("the 14 wired op types through the loader (real rows → the per-item projection)", () => {
  for (const row of LOADER_MATRIX) {
    it(row.name, async () => {
      await seedBaseFixtures();
      // The live-comment rows get their ids from THIS test's fresh fixtures.
      const commentId = row.opType === "comment_issue" ? comment7Id : row.opType === "comment_pull" ? comment9Id : undefined;
      const insert: ActionInsert = { ...row.insert, commentId };
      await insertAction(insert);

      const data = await load(selfViewer);
      expect(data.items).toHaveLength(1);
      const item = data.items[0];
      if (item === undefined) throw new Error("expected the single feed item");
      expect(item.opType).toBe(row.opType);
      expect(item.icon).toBe(row.icon);
      expect(item.message).toEqual(row.message);
      row.checkBody(item);
    });
  }

  it("a publish_release row with a BARE ref skips the prefix strip (tagOf passthrough)", async () => {
    await seedBaseFixtures();
    await insertAction({ opType: ActionType.PublishRelease, content: "v2", refName: "v2" });
    const item = (await load(selfViewer)).items[0];
    expect(item?.message).toEqual([
      seg.text("released "),
      seg.link("/alice/demo/releases/tag/v2", "v2"),
      seg.text(" at "),
      seg.link("/alice/demo", "alice/demo"),
    ]);
  });

  it("a comment arm with an EMPTY excerpt renders no render-content div (infos[1] === '')", async () => {
    await seedBaseFixtures();
    await insertAction({ opType: ActionType.ApprovePullRequest, content: "9|" });
    const item = (await load(selfViewer)).items[0];
    expect(item?.body).toMatchObject({ kind: "comment", href: "/alice/demo/pulls/9", title: "The Pull", excerptHtml: null });
    expect(renderPage(await load(selfViewer))).not.toContain('class="render-content markup"');
  });

  it("an unproduced upstream type degrades through REAL data: the question glyph, no message, no body", async () => {
    await seedBaseFixtures();
    // commit_repo: mapped on the wire (action.go) but no landed producer —
    // feeds.tmpl's if-chain has no default branch, ActionIcon falls to
    // octicon-question.
    await insertAction({ opType: ActionType.CommitRepo, content: "1|ignored" });
    const item = (await load(selfViewer)).items[0];
    expect(item?.opType).toBe("commit_repo");
    expect(item?.icon).toBe("octicon-question");
    expect(item?.message).toBeNull();
    expect(item?.body).toBeNull();
  });
});

// --- the pagination matrix ---------------------------------------------------------

/** Seed `count` ascending create_issue rows (one per index; the content-stored
 *  titles need no issue rows). */
async function seedPageRows(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertAction({ opType: ActionType.CreateIssue, content: `${i + 1}|row`, createdAt: T0 + i });
  }
}

describe("the pagination matrix (the Older/Newer reduction's four shapes)", () => {
  it("page 1 with more renders the Older link only, at the canonical +page=2 href", async () => {
    await seedBaseFixtures();
    await seedPageRows(ACTIVITY_FEEDS_PAGE_SIZE + 1);

    const data = await load(selfViewer);
    expect(data.items).toHaveLength(ACTIVITY_FEEDS_PAGE_SIZE);
    expect(data.more).toBe(true);
    const html = renderPage(data);
    expect(html).toContain(">Older<");
    expect(html).not.toContain(">Newer<"); // page <= 1: no Newer
    expect(html).toContain('href="/alice?tab=activity&amp;page=2"');
  });

  it("a middle page renders both links — Newer canonical (page 1 omits the param), Older ahead", async () => {
    await seedBaseFixtures();
    await seedPageRows(2 * ACTIVITY_FEEDS_PAGE_SIZE + 1);

    const data = await load(selfViewer, new URLSearchParams({ page: "2" }));
    expect(data.page).toBe(2);
    expect(data.items).toHaveLength(ACTIVITY_FEEDS_PAGE_SIZE);
    expect(data.more).toBe(true);
    const html = renderPage(data);
    expect(html).toContain(">Newer<");
    expect(html).toContain(">Older<");
    expect(html).toContain('href="/alice?tab=activity"'); // the Newer target, no page=1
    expect(html).toContain('href="/alice?tab=activity&amp;page=3"');
  });

  it("the last page renders the Newer link only", async () => {
    await seedBaseFixtures();
    await seedPageRows(2 * ACTIVITY_FEEDS_PAGE_SIZE + 1);

    const data = await load(selfViewer, new URLSearchParams({ page: "3" }));
    expect(data.items).toHaveLength(1);
    expect(data.more).toBe(false);
    const html = renderPage(data);
    expect(html).toContain(">Newer<");
    expect(html).not.toContain(">Older<");
    expect(html).toContain('href="/alice?tab=activity&amp;page=2"');
  });

  it("a page beyond the range renders empty with the pager still pointed back (the FIXME-quirk reduction)", async () => {
    await seedBaseFixtures();
    await seedPageRows(2 * ACTIVITY_FEEDS_PAGE_SIZE + 1);

    const data = await load(selfViewer, new URLSearchParams({ page: "99" }));
    expect(data.items).toEqual([]);
    expect(data.total).toBe(2 * ACTIVITY_FEEDS_PAGE_SIZE + 1); // the unpaginated bound
    expect(data.more).toBe(false);
    const html = renderPage(data);
    expect(html).toContain(">Newer<"); // page > 1 keeps its back link
    expect(html).toContain('href="/alice?tab=activity&amp;page=98"');
  });

  it("junk and non-positive page params fold onto page 1 (parsePageNumber)", async () => {
    await seedBaseFixtures();
    await seedPageRows(ACTIVITY_FEEDS_PAGE_SIZE + 1);

    for (const raw of ["abc", "0", "-3", "2x", "1.5"]) {
      const data = await load(selfViewer, new URLSearchParams({ page: raw }));
      expect(data.page, raw).toBe(1);
      expect(data.items, raw).toHaveLength(ACTIVITY_FEEDS_PAGE_SIZE);
      expect(data.items[0]?.content, raw).toBe(`${ACTIVITY_FEEDS_PAGE_SIZE + 1}|row`); // the newest, DESC order
    }
  });

  it("the active date rides every pager href (tab, then date, then page)", async () => {
    await seedBaseFixtures();
    await seedPageRows(ACTIVITY_FEEDS_PAGE_SIZE + 1); // all inside the T0 UTC day

    const data = await load(selfViewer, new URLSearchParams({ date: "2023-11-14", page: "2" }));
    expect(data.date).toBe("2023-11-14");
    expect(data.items).toHaveLength(1);
    expect(data.more).toBe(false);
    const html = renderPage(data);
    expect(html).toContain(">Newer<");
    expect(html).toContain('href="/alice?tab=activity&amp;date=2023-11-14"'); // the Newer target keeps the window
    expect(html).not.toContain(">Older<");
  });

  it("an empty feed still renders the container and no pager (feeds.tmpl's unconditional container)", async () => {
    await seedBaseFixtures();

    const data = await load(selfViewer);
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    const html = renderPage(data);
    expect(html).toContain('id="activity-feed"');
    expect(html).not.toContain(">Newer<");
    expect(html).not.toContain(">Older<");
  });
});

// --- the cross-scope resolution gates (org vs user) -------------------------------

describe("the cross-scope resolution gates (resolveActivityFeeds: org vs user)", () => {
  it("an org name answers the org arm even under ?tab=activity (the query rides along, ignored)", async () => {
    await seedBaseFixtures();
    await env.DB.prepare(
      "INSERT INTO users (username, username_lower, type, created_at) VALUES ('myorg', 'myorg', 'org', unixepoch())",
    ).run();

    const resolution = await resolveActivityFeeds(env.DB, "myorg", { id: null, isAdmin: false }, "/myorg", "tab=activity&page=2");
    if (resolution.kind !== "org") throw new Error("expected the org arm");
    expect(resolution.org.username).toBe("myorg");
  });

  it("a renamed ORG 307s from the org half with the query preserved", async () => {
    await seedBaseFixtures();
    const org = await env.DB.prepare(
      "INSERT INTO users (username, username_lower, type, created_at) VALUES ('myorg', 'myorg', 'org', unixepoch())",
    ).run();
    await env.DB.prepare("INSERT INTO user_redirects (lower_name, redirect_user_id) VALUES ('oldorg', ?)")
      .bind(org.meta.last_row_id)
      .run();

    const resolution = await resolveActivityFeeds(env.DB, "oldorg", { id: null, isAdmin: false }, "/oldorg", "tab=activity");
    expect(resolution).toEqual({ kind: "redirect", location: "/myorg?tab=activity" });
  });

  it("a renamed USER answers from the user half — the org half's type gate never leaks a user-target redirect", async () => {
    await seedBaseFixtures();
    await env.DB.prepare("INSERT INTO user_redirects (lower_name, redirect_user_id) VALUES ('oldalice', 1)").run();

    // The org half resolves the redirect row, reads the USER target through
    // the type gate and folds to missing; the user half then serves the 307.
    const resolution = await resolveActivityFeeds(
      env.DB,
      "oldalice",
      { id: null, isAdmin: false },
      "/oldalice",
      "tab=activity",
    );
    expect(resolution).toEqual({ kind: "redirect", location: "/alice?tab=activity" });
  });

  it("an invisible (private) org folds into missing for anonymous; a member resolves it", async () => {
    await seedBaseFixtures();
    const org = await env.DB.prepare(
      "INSERT INTO users (username, username_lower, type, visibility, created_at) VALUES ('secorg', 'secorg', 'org', 'private', unixepoch())",
    ).run();
    const orgId = org.meta.last_row_id;
    await env.DB.prepare("INSERT INTO org_members (org_id, user_id, is_public, role, created_at) VALUES (?, ?, 0, 'member', unixepoch())")
      .bind(orgId, bobId)
      .run();

    const anon = await resolveActivityFeeds(env.DB, "secorg", { id: null, isAdmin: false }, "/secorg", "");
    expect(anon).toEqual({ kind: "missing" }); // indistinguishable from missing — existence never leaks

    const member = await resolveActivityFeeds(env.DB, "secorg", { id: bobId, isAdmin: false }, "/secorg", "");
    if (member.kind !== "org") throw new Error("expected the member's org arm");
    expect(member.org.username).toBe("secorg");
  });

  it("a private-visibility user: anonymous and strangers fold into missing, a follower resolves (the IsFollowing arm)", async () => {
    await seedBaseFixtures();
    await env.DB.prepare("UPDATE users SET visibility = 'private' WHERE id = 1").run();
    const anonDoer = { id: null, isAdmin: false };
    const strangerDoer = { id: bobId, isAdmin: false };

    expect(await resolveActivityFeeds(env.DB, "alice", anonDoer, "/alice", "")).toEqual({ kind: "missing" });
    expect(await resolveActivityFeeds(env.DB, "alice", strangerDoer, "/alice", "")).toEqual({ kind: "missing" });

    // follows(user_id = followed, follow_id = follower) — the verbatim
    // IsFollowing(u.ID, viewer.ID) argument order (user.go:1526).
    await env.DB.prepare("INSERT INTO follows (user_id, follow_id, created_at) VALUES (1, ?, unixepoch())")
      .bind(bobId)
      .run();
    const follower = await resolveActivityFeeds(env.DB, "alice", strangerDoer, "/alice", "tab=activity");
    if (follower.kind !== "user") throw new Error("expected the follower's user arm");
    expect(follower.user.username).toBe("alice");
  });

  it("a prohibited user is invisible for every viewer (the status gate precedes the ladder)", async () => {
    await seedBaseFixtures();
    await env.DB.prepare(
      "INSERT INTO users (username, username_lower, status, created_at) VALUES ('ghost', 'ghost', 'prohibited', unixepoch())",
    ).run();
    const ghost = await userRow("ghost");

    expect(
      await resolveActivityFeeds(env.DB, "ghost", { id: null, isAdmin: false }, "/ghost", ""),
    ).toEqual({ kind: "missing" });
    // Even the user themself: the status gate answers before the ladder's
    // self short-circuit could.
    expect(await resolveActivityFeeds(env.DB, "ghost", { id: ghost.id, isAdmin: false }, "/ghost", "")).toEqual({
      kind: "missing",
    });
    expect(
      await resolveActivityFeeds(env.DB, "ghost", { id: rootId, isAdmin: true }, "/ghost", ""),
    ).toEqual({ kind: "missing" });
  });
});
