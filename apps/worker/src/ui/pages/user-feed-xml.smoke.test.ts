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
 *   3. Query-shape witness (the query-shape-audit C2 mirror): the loader's
 *      live-issue read probes the page's (repoId, index) pairs through the
 *      service's `feedIssueTitles` — dual IN filters + rows_read strictly
 *      under the corpus, the repo-only select it replaced pinned to fail
 *      on revert.
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

// --- the query-shape witness (query-shape-audit C2, the xml mirror) --------------

// The loader's live-issue read used to select EVERY issue of the referenced
// repos (`inArray(issues.repoId, ...)`, post-filtered in memory) to fill the
// {title, isPull, content} rows the projection arms read — hundreds of rows
// to fill ≤ page-size pairs on a grown corpus. It now consolidates onto the
// service's `feedIssueTitles` (wide variant), whose select filters BOTH
// columns through the (repo_id, index) unique index. Metered the
// activity-feeds.test.ts C2 witness way (the prepare-counting wrapper +
// bench-d1.test.ts's rows_read protocol): drizzle's mapped SELECT path
// executes through raw(), which drops the D1Result meta, so raw()-routed
// statements are recorded and replayed untimed after the load — the loader
// is read-only, so the replay reports the same rows_read.

/** Corpus size the witness grows the demo repo to (indexes 1..45; the base
 *  fixture's 7 and the pull's 9 ride inside the range). The pre-fix read
 *  drew all of these rows to fill two referenced pairs. */
const C2_XML_CORPUS_ISSUES = 45;

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

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

describe("user feed xml query-shape witness (query-shape-audit C2, the xml mirror)", () => {
  it("the live-issue read probes the referenced pairs, not every issue of the referenced repos", async () => {
    await seedBaseFixtures();
    // The referenced pull: index 9, is_pull — the HTMLURL path split rides
    // the widened read (C2's fixture shape).
    await env.DB.prepare(
      "INSERT INTO issues (repo_id, `index`, poster_id, title, is_pull, created_unix) VALUES (?, 9, 1, 'The Pull', 1, unixepoch())",
    )
      .bind(REPO_ID)
      .run();
    // Grow the demo repo's corpus around the fixtures' issues 7 and 9.
    for (const index of Array.from({ length: C2_XML_CORPUS_ISSUES }, (_, i) => i + 1)) {
      if (index === 7 || index === 9) continue;
      await env.DB.prepare(
        "INSERT INTO issues (repo_id, `index`, poster_id, title, is_pull, created_unix) VALUES (?, ?, 1, ?, 0, unixepoch())",
      )
        .bind(REPO_ID, index, `Corpus issue ${index}`)
        .run();
    }
    // The page's live-issue arms reference exactly two (repoId, index)
    // pairs: the close_issue's title arm and the close_pull_request's
    // title + HTMLURL-path arms.
    await insertAction(ActionType.CloseIssue, { content: "7|", createdAt: T0 + 30 });
    await insertAction(ActionType.ClosePullRequest, { content: "9|", createdAt: T0 + 60 });

    const meter = countedD1();
    const data = await loadUserFeedData(meter.db, aliceSubject, selfViewer, ORIGIN, new URLSearchParams());
    // Contract unchanged: both live-issue arms still resolve — the title
    // texts through the wide read, the pulls path through its is_pull.
    expect(data.items).toHaveLength(2);
    const rss = renderUserFeedRss(data);
    expect(rss).toContain("Live issue title");
    expect(rss).toContain("The Pull");
    expect(rss).toContain(`${ORIGIN}/alice/demo/issues/7`);
    expect(rss).toContain(`${ORIGIN}/alice/demo/pulls/9`);
    // No corpus row ever surfaces (the projection reads referenced pairs only).
    expect(rss).not.toContain("Corpus issue");

    // (a) Statement count fixed at the documented arms — 2 (page + count)
    // + 2 (act users + repo pairs) + 1 (coordinates) + 1 (live-issue read)
    // = 6, corpus-independent.
    expect(meter.count()).toBeLessThanOrEqual(6);

    // (b) The loader's ACTUAL live-issue statement carries BOTH filters and
    // the widened columns — a revert to the repo-only title-only select
    // fails this pin. Exactly one statement filters on repo_id: this match
    // is unique to the live-issue read.
    const matches = meter.queries().filter((sql) => sql.includes('"repo_id" in'));
    expect(matches).toHaveLength(1);
    const issueSql = matches[0];
    expect(issueSql, "the loader must issue the service's batched live-issue read").toBeDefined();
    expect(issueSql).toMatch(/"index" in/);
    expect(issueSql).toContain('"is_pull"');
    expect(issueSql).toContain('"content"');

    // (c) The cost anchor, side by side on the same corpus: the loader's
    // replayed live-issue statement reads the referenced pairs only —
    // strictly under the corpus — while the pre-fix repo-only shape (raw
    // statement, meta carried directly) reads every corpus row.
    const fixedRead = await meter.rowsReadOf((sql) => sql.includes('"repo_id" in'));
    expect(fixedRead).toBeGreaterThan(0);
    expect(fixedRead).toBeLessThan(C2_XML_CORPUS_ISSUES);
    const preFix = await env.DB.prepare('SELECT "repo_id", "index", "title" FROM "issues" WHERE "repo_id" IN (?)')
      .bind(REPO_ID)
      .all();
    const preFixRead = preFix.meta?.rows_read ?? 0;
    expect(preFixRead).toBeGreaterThanOrEqual(C2_XML_CORPUS_ISSUES);
    expect(fixedRead).toBeLessThan(preFixRead);
  });
});
