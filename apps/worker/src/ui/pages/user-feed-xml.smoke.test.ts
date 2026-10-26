/**
 * user-feed-xml smoke — the wave-74 bench row, PORT-FIRST gates: ONE
 * happy-path smoke per envelope (real seeded data → byte-exact document),
 * no test matrix (the polish wave owns the remaining arms — the module
 * doc's reductions section carries their cites).
 *
 *   1. RSS: `loadUserFeedData` over a seeded public create_repo +
 *      comment_issue (live issue + comment) as an ANONYMOUS viewer →
 *      `renderUserFeedRss` → the full document compared byte-for-byte
 *      against the verified gorilla/feeds v1.2.0 shape (channel fields,
 *      item element order, CDATA body, `&#34;`/`&lt;`/`&#xA;` escaping),
 *      plus the private-action exclusion (a seeded is_private action on a
 *      private repo never surfaces).
 *   2. Atom: the same fixtures → `renderUserFeedAtom` → the full document
 *      byte-for-byte (feed/entry shapes, `<content type="html">`,
 *      `<summary type="html">`, the author block), plus a builder-level
 *      `<subtitle>` assert for the non-empty-bio arm.
 *
 * Harness posture: the module functions driven DIRECTLY (the
 * repo-lastcommit-fragment test's convention — the route arm is
 * index-owned; the module doc's HANDOFF NOTE carries the mount recipe),
 * against the real workerd D1 (generated migrations in beforeAll).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { ActionType } from "../../api/services/activity-feeds";
import {
  USER_FEED_CONTENT_TYPES,
  formatRfc1123z,
  formatRfc3339,
  loadUserFeedData,
  renderUserFeedAtom,
  renderUserFeedRss,
  type UserFeedSubject,
} from "./user-feed-xml";
import type { Viewer } from "../viewer";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch (a Tuesday)
const ORIGIN = "https://feed.test";
const REPO_ID = "repo-demo";
const SECRET_REPO_ID = "repo-secret";

const anonymous: Viewer = { kind: "anonymous" };

/** alice: bio-less (the empty-bio arm: RSS emits the empty
 *  `<description></description>`, Atom drops `<subtitle>`). */
const aliceSubject: UserFeedSubject = {
  kind: "user",
  id: 1,
  username: "alice",
  fullName: null,
  email: "alice@example.com",
  description: null,
};

let commentId = 0;
let createRepoActionId = 0;
let commentIssueActionId = 0;

async function seedBaseFixtures(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, email, created_at) VALUES (1, 'alice', 'alice', NULL, 'alice@example.com', unixepoch())",
  ).run();

  for (const [id, slug, visibility] of [
    [REPO_ID, "demo", "public"],
    [SECRET_REPO_ID, "secret", "private"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, created_at) VALUES (?, ?, 'alice', 1, ?, ?, unixepoch())",
    )
      .bind(id, id, slug, visibility)
      .run();
  }

  const issue7 = await env.DB.prepare(
    "INSERT INTO issues (repo_id, `index`, poster_id, title, is_pull, created_unix) VALUES (?, 7, 1, 'Live issue title', 0, unixepoch())",
  )
    .bind(REPO_ID)
    .run();
  const comment7 = await env.DB.prepare(
    "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, 1, ?, 'A **comment** body', unixepoch())",
  )
    .bind(issue7.meta.last_row_id)
    .run();
  commentId = comment7.meta.last_row_id;
}

async function insertAction(
  opType: number,
  opts: { repoId?: string; content?: string; commentId?: number; isPrivate?: boolean; createdAt: number },
): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO action (user_id, op_type, act_user_id, repo_id, comment_id, is_deleted, ref_name, is_private, content, created_unix) VALUES (1, ?, 1, ?, ?, 0, '', ?, ?, ?)",
  )
    .bind(
      opType,
      opts.repoId ?? REPO_ID,
      opts.commentId ?? 0,
      opts.isPrivate === true ? 1 : 0,
      opts.content ?? "",
      opts.createdAt,
    )
    .run();
  return result.meta.last_row_id;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["action", "comments", "issues", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  commentId = 0;
  createRepoActionId = 0;
  commentIssueActionId = 0;
});

/** Seed the happy path: public create_repo (T0), public comment_issue with
 *  a live comment (T0+60 — the feed's newest row), and a PRIVATE
 *  create_issue on the private repo (T0+30 — the exclusion assert). */
async function seedHappyPath(): Promise<void> {
  await seedBaseFixtures();
  createRepoActionId = await insertAction(ActionType.CreateRepo, { createdAt: T0 });
  commentIssueActionId = await insertAction(ActionType.CommentIssue, {
    content: "7|A **comment** body",
    commentId,
    createdAt: T0 + 60,
  });
  await insertAction(ActionType.CreateIssue, {
    repoId: SECRET_REPO_ID,
    content: "1|secret excerpt",
    isPrivate: true,
    createdAt: T0 + 30,
  });
}

// --- the two envelopes ---------------------------------------------------------

describe("user feed xml envelopes (the /{username}.rss + .atom byte surfaces)", () => {
  it("RSS: seeded public actions → the gorilla WriteRss document, private actions excluded", async () => {
    await seedHappyPath();

    const data = await loadUserFeedData(env.DB, aliceSubject, anonymous, ORIGIN, new URLSearchParams());
    expect(data.total).toBe(2);
    expect(data.items).toHaveLength(2); // newest first: comment_issue, then create_repo
    expect(data.title).toBe('Feed of "alice"');
    expect(data.link).toBe(`${ORIGIN}/alice`);
    expect(data.descriptionHtml).toBe(""); // bio-less subject

    const rss = renderUserFeedRss(data);
    expect(USER_FEED_CONTENT_TYPES.rss).toBe("application/rss+xml;charset=utf-8");

    // The full document, byte-for-byte (the generated pubDate interpolated).
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
      `  <channel>`,
      `    <title>Feed of &#34;alice&#34;</title>`,
      `    <link>https://feed.test/alice</link>`,
      `    <description></description>`,
      `    <pubDate>${formatRfc1123z(data.generatedUnix)}</pubDate>`,
      `    <item>`,
      `      <title>alice commented on issue &lt;a href=&#34;https://feed.test/alice/demo/issues/7&#34;&gt;alice/demo#7&lt;/a&gt;</title>`,
      `      <link>https://feed.test/alice/demo/issues/7#issuecomment-${commentId}</link>`,
      `      <description>Live issue title&#xA;&#xA;&lt;p&gt;A &lt;strong&gt;comment&lt;/strong&gt; body&lt;/p&gt;&#xA;</description>`,
      `      <content:encoded><![CDATA[Live issue title`,
      ``,
      `<p>A <strong>comment</strong> body</p>`,
      `]]></content:encoded>`,
      `      <author>alice</author>`,
      `      <guid isPermaLink="false">${commentIssueActionId}: https://feed.test/alice/demo/issues/7#issuecomment-${commentId}</guid>`,
      `      <pubDate>Tue, 14 Nov 2023 22:14:20 +0000</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>alice created repository &lt;a href=&#34;https://feed.test/alice/demo&#34;&gt;alice/demo&lt;/a&gt;</title>`,
      `      <link>https://feed.test/alice/demo</link>`,
      `      <description></description>`,
      `      <author>alice</author>`,
      `      <guid isPermaLink="false">${createRepoActionId}: https://feed.test/alice/demo</guid>`,
      `      <pubDate>Tue, 14 Nov 2023 22:13:20 +0000</pubDate>`,
      `    </item>`,
      `  </channel>`,
      `</rss>`,
    ].join("\n");
    expect(rss).toBe(expected);

    // The private-action exclusion: neither the private repo nor its
    // excerpt surface anywhere in the document.
    expect(rss).not.toContain("secret");
  });

  it("Atom: seeded public actions → the gorilla WriteAtom document, private actions excluded", async () => {
    await seedHappyPath();

    const data = await loadUserFeedData(env.DB, aliceSubject, anonymous, ORIGIN, new URLSearchParams());
    expect(USER_FEED_CONTENT_TYPES.atom).toBe("application/atom+xml;charset=utf-8");

    const atom = renderUserFeedAtom(data);

    // The full document, byte-for-byte. The author email is HIDDEN for the
    // anonymous renderer (apiUserFromRow's landed posture) → no <email>.
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">`,
      `  <title>Feed of &#34;alice&#34;</title>`,
      `  <id>https://feed.test/alice</id>`,
      `  <updated>${formatRfc3339(data.generatedUnix)}</updated>`,
      `  <link href="https://feed.test/alice"></link>`,
      `  <entry>`,
      `    <title>alice commented on issue &lt;a href=&#34;https://feed.test/alice/demo/issues/7&#34;&gt;alice/demo#7&lt;/a&gt;</title>`,
      `    <updated>2023-11-14T22:14:20Z</updated>`,
      `    <id>${commentIssueActionId}: https://feed.test/alice/demo/issues/7#issuecomment-${commentId}</id>`,
      `    <content type="html">Live issue title&#xA;&#xA;&lt;p&gt;A &lt;strong&gt;comment&lt;/strong&gt; body&lt;/p&gt;&#xA;</content>`,
      `    <link href="https://feed.test/alice/demo/issues/7#issuecomment-${commentId}" rel="alternate"></link>`,
      `    <summary type="html">Live issue title&#xA;&#xA;&lt;p&gt;A &lt;strong&gt;comment&lt;/strong&gt; body&lt;/p&gt;&#xA;</summary>`,
      `    <author>`,
      `      <name>alice</name>`,
      `    </author>`,
      `  </entry>`,
      `  <entry>`,
      `    <title>alice created repository &lt;a href=&#34;https://feed.test/alice/demo&#34;&gt;alice/demo&lt;/a&gt;</title>`,
      `    <updated>2023-11-14T22:13:20Z</updated>`,
      `    <id>${createRepoActionId}: https://feed.test/alice/demo</id>`,
      `    <link href="https://feed.test/alice/demo" rel="alternate"></link>`,
      `    <author>`,
      `      <name>alice</name>`,
      `    </author>`,
      `  </entry>`,
      `</feed>`,
    ].join("\n");
    expect(atom).toBe(expected);

    // The private-action exclusion.
    expect(atom).not.toContain("secret");

    // The non-empty-bio arm: a bio renders the escaped <subtitle> (the
    // bio-less fixture above drops it — the omitempty arm).
    const withBio = renderUserFeedAtom({ ...data, descriptionHtml: `<p>bio "quoted"</p>` });
    expect(withBio).toContain(`<subtitle>&lt;p&gt;bio &#34;quoted&#34;&lt;/p&gt;</subtitle>`);
  });
});
