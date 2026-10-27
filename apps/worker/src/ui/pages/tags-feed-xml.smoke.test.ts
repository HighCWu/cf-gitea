/**
 * tags-feed-xml smoke — the wave-tags-feeds bench row, PORT-FIRST gates
 * (the releases-feed twin's shape): real seeded data → byte-exact
 * documents, no test matrix (the polish wave owns the remaining arms —
 * the module doc's reductions section carries their cites).
 *
 *   1. RSS: `loadTagsFeedData` over a REAL pushed repo (four engine tags:
 *      one release-backed, one shadowed by a DRAFT release row, one with
 *      a tag-only record, one rowless) → `renderTagsFeedRss` → the full
 *      document compared byte-for-byte against the verified gorilla/feeds
 *      v1.2.0 shape for the tags projection (channel fields incl. the
 *      plain `/tags` link — no singular quirk here, the ALWAYS-empty
 *      `<description>`, the CDATA note, the bare `<guid>` — NO
 *      isPermaLink attr; the rowless tags' zero-id guid + epoch pubDate +
 *      missing author; the tag-only record's ghost author + /src/tag
 *      link) — the draft row excluded, byte-asc item order.
 *   2. Atom: the same fixtures → `renderTagsFeedAtom` → the full
 *      document byte-for-byte (no `<summary>` ever, the release item's
 *      author email, the ghost's bare `<name>`, the `<subtitle>` over the
 *      raw description) + a builder-level empty-description arm
 *      (subtitle drops).
 *   3. The `repo.MustBeNotEmpty` arm: an empty repo → `null` (the route
 *      404-shells; the loader answers before any engine read).
 *   4. The `canReadReleases=false` degraded arm (the releases unit
 *      disabled — the tags group has NO release-reader gate, web.go:1502):
 *      every item reverts to the TagName title + the `/src/tag` link with
 *      no content, authors still render (convert.go sets them outside the
 *      branch).
 *
 * Harness posture: the module functions driven DIRECTLY (the releases
 * twin's convention — the route arm is index-owned; the module doc's
 * HANDOFF NOTE carries the mount recipe), against the real workerd
 * bindings (D1 + the REPO cell — the tag universe is pushed content via
 * the landed receive flow, the seed-repo helper).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";
import {
  TAGS_FEED_CONTENT_TYPES,
  loadTagsFeedData,
  renderTagsFeedAtom,
  renderTagsFeedRss,
} from "./tags-feed-xml";
import { formatRfc1123z, formatRfc3339 } from "./user-feed-xml";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch (a Tuesday)
const TAG_PUBLISHED = T0 + 1800; // the tag-only record's published_unix
const ORIGIN = "https://feed.test";
const OWNER = "alice";
const SLUG = "tagsfeed";
const EMPTY_REPO_ID = "repo-empty";

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "tagsfeed smoke: root commit",
    time: T0,
    files: [{ path: "README.md", content: "tagsfeed root\n" }],
  },
];

/** The four engine tags (one commit, all pointing at it): byte-asc order
 *  v0.1.0 < v0.5.0 < v0.9.0 < v1.0.0 — the feed's item order. */
const SEED_TAGS = ["v0.1.0", "v0.5.0", "v0.9.0", "v1.0.0"];

/** The fixture's captured row ids (AUTOINCREMENT — asserted via
 *  interpolation, never literals, like the twin's smoke). */
interface TagsFeedFixture {
  repo: RepoRow;
  releaseRowId: number; // v1.0.0's release row
  tagRecordId: number; // v0.5.0's tag-only record
}

async function repoRow(id: string): Promise<RepoRow> {
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, id)).get();
  if (row === undefined) throw new Error(`fixture missing: ${id}`);
  return row;
}

async function insertRelease(
  repoId: string,
  opts: {
    tagName: string;
    title: string;
    note: string;
    isDraft?: boolean;
    isTag?: boolean;
    publisherId?: number;
    createdAt: number;
    publishedUnix: number;
  },
): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO releases (repo_id, publisher_id, tag_name, lower_tag_name, title, note, is_draft, is_prerelease, is_tag, created_unix, published_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      repoId,
      opts.publisherId ?? 1,
      opts.tagName,
      opts.tagName.toLowerCase(),
      opts.title,
      opts.note,
      opts.isDraft === true ? 1 : 0,
      0,
      opts.isTag === true ? 1 : 0,
      opts.createdAt,
      opts.publishedUnix,
    )
    .run();
  return result.meta.last_row_id;
}

/**
 * The idempotent fixture: the REAL pushed repo (four tags through the
 * receive flow), alice's email (the Atom `<email>` arm), the release rows
 * over the three D1-coupled tags, the RAW channel description, and the
 * empty-repo row. Repo-scoped rows are wiped per call so repeated runs
 * (rolled back or not) stay consistent.
 */
async function seedFixture(): Promise<TagsFeedFixture> {
  await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS, tags: SEED_TAGS.map((name) => ({ name, commitIndex: 0 })) });
  await env.DB.prepare("UPDATE users SET email = 'alice@example.com' WHERE username_lower = 'alice'").run();

  // The seeded owner's REAL id (AUTOINCREMENT — the isolate may carry
  // other bootstrap users, so the publisher ids are never hardcoded).
  const alice = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, OWNER))
    .get();
  if (alice === undefined) throw new Error("fixture missing: the seeded owner row");

  const repoRow = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, SLUG)))
    .get();
  if (repoRow === undefined) throw new Error("fixture missing: the seeded repo row");
  const repo = repoRow;

  await env.DB.prepare("DELETE FROM releases WHERE repo_id = ?").bind(repo.id).run();
  await env.DB.prepare("DELETE FROM repo_settings WHERE repo_id = ? OR repo_id = ?").bind(repo.id, EMPTY_REPO_ID).run();
  await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(EMPTY_REPO_ID).run();

  // The RAW channel description (the repo_settings store).
  await env.DB.prepare("INSERT INTO repo_settings (repo_id, description) VALUES (?, ?)")
    .bind(repo.id, 'A "tag" repo <feed>')
    .run();

  // v1.0.0 — the RELEASE row (release-backed arm, the escaping-exercise
  // title, markdown note, alice as publisher).
  const releaseRowId = await insertRelease(repo.id, {
    tagName: "v1.0.0",
    title: 'R&D <v1> "one"',
    note: "Notes **bold** here",
    publisherId: alice.id,
    createdAt: T0,
    publishedUnix: T0,
  });
  // v0.9.0 — the DRAFT (is_draft=1 — ToConds' IncludeDrafts-unset arm
  // excludes it; the tag then renders as a ROWLESS plain tag).
  await insertRelease(repo.id, {
    tagName: "v0.9.0",
    title: "Sneaky draft",
    note: "never surfaces",
    isDraft: true,
    publisherId: alice.id,
    createdAt: T0 + 7200,
    publishedUnix: 0,
  });
  // v0.5.0 — the TAG-ONLY record (is_tag=1): the TagName-title arm, the
  // /src/tag link, and the ghost publisher (a missing user row).
  const tagRecordId = await insertRelease(repo.id, {
    tagName: "v0.5.0",
    title: "",
    note: "",
    isTag: true,
    publisherId: 4242,
    createdAt: TAG_PUBLISHED,
    publishedUnix: TAG_PUBLISHED,
  });

  // The MustBeNotEmpty arm's empty repo (no engine content — the loader
  // answers null before any engine read).
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, is_empty, created_at) VALUES (?, ?, ?, ?, 'hollow', 'public', 1, unixepoch())",
  )
    .bind(EMPTY_REPO_ID, EMPTY_REPO_ID, repo.ownerNamespace, repo.ownerId)
    .run();

  return { repo, releaseRowId, tagRecordId };
}

let fixture: TagsFeedFixture;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = await seedFixture();
});

// --- the two envelopes ---------------------------------------------------------

describe("tags feed xml envelopes (the /{owner}/{repo}/tags.rss + .atom byte surfaces)", () => {
  it("RSS: seeded tags → the gorilla WriteRss document, draft excluded, the three row shapes", async () => {
    const data = await loadTagsFeedData(env, env.DB, fixture.repo, ORIGIN);
    expect(data).not.toBeNull();
    expect(data?.items.map((item) => item.title)).toEqual([
      "v0.1.0", // the rowless engine tag — byte-asc order, no author, zero id, epoch
      "v0.5.0", // the tag-only record — TagName title, ghost author, /src/tag link
      "v0.9.0", // the draft-shadowed tag — the draft row excluded, renders rowless
      'R&D <v1> "one"', // the release-backed tag — the Title arm (escaped)
    ]);
    expect(data?.title).toBe("Tags for alice/tagsfeed");
    expect(data?.link).toBe(`${ORIGIN}/alice/tagsfeed/tags`); // the plain plural tail
    expect(data?.description).toBe('A "tag" repo <feed>'); // RAW — no markdown render

    expect(TAGS_FEED_CONTENT_TYPES.rss).toBe("application/rss+xml;charset=utf-8");

    const rss = renderTagsFeedRss(data!);

    // The full document, byte-for-byte (the generated pubDate interpolated).
    // Note the release-item deltas (always-empty <description>, bare
    // <guid>) and the rowless tags' zero-id guid + epoch pubDate + missing
    // <author>.
    const srcTag = (name: string): string => `${ORIGIN}/alice/tagsfeed/src/tag/${name}`;
    const releaseTag = `${ORIGIN}/alice/tagsfeed/releases/tag/v1.0.0`;
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
      `  <channel>`,
      `    <title>Tags for alice/tagsfeed</title>`,
      `    <link>${ORIGIN}/alice/tagsfeed/tags</link>`,
      `    <description>A &#34;tag&#34; repo &lt;feed&gt;</description>`,
      `    <pubDate>${formatRfc1123z(data!.generatedUnix)}</pubDate>`,
      `    <item>`,
      `      <title>v0.1.0</title>`,
      `      <link>${srcTag("v0.1.0")}</link>`,
      `      <description></description>`,
      `      <guid>0: ${srcTag("v0.1.0")}</guid>`,
      `      <pubDate>Thu, 01 Jan 1970 00:00:00 +0000</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>v0.5.0</title>`,
      `      <link>${srcTag("v0.5.0")}</link>`,
      `      <description></description>`,
      `      <author>Ghost</author>`,
      `      <guid>${fixture.tagRecordId}: ${srcTag("v0.5.0")}</guid>`,
      `      <pubDate>Tue, 14 Nov 2023 22:43:20 +0000</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>v0.9.0</title>`,
      `      <link>${srcTag("v0.9.0")}</link>`,
      `      <description></description>`,
      `      <guid>0: ${srcTag("v0.9.0")}</guid>`,
      `      <pubDate>Thu, 01 Jan 1970 00:00:00 +0000</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>R&amp;D &lt;v1&gt; &#34;one&#34;</title>`,
      `      <link>${releaseTag}</link>`,
      `      <description></description>`,
      `      <content:encoded><![CDATA[<p>Notes <strong>bold</strong> here</p>`,
      `]]></content:encoded>`,
      `      <author>alice</author>`,
      `      <guid>${fixture.releaseRowId}: ${releaseTag}</guid>`,
      `      <pubDate>Tue, 14 Nov 2023 22:13:20 +0000</pubDate>`,
      `    </item>`,
      `  </channel>`,
      `</rss>`,
    ].join("\n");
    expect(rss).toBe(expected);

    // The draft exclusion: neither the draft's title nor its row surfaces.
    expect(rss).not.toContain("Sneaky draft");
  });

  it("Atom: seeded tags → the gorilla WriteAtom document (no summary ever, the ghost bare-name author), subtitle arm", async () => {
    const data = await loadTagsFeedData(env, env.DB, fixture.repo, ORIGIN);
    expect(data).not.toBeNull();

    expect(TAGS_FEED_CONTENT_TYPES.atom).toBe("application/atom+xml;charset=utf-8");

    const atom = renderTagsFeedAtom(data!);

    // The full document, byte-for-byte. No <summary> element exists —
    // release/tag items never set a description upstream.
    const srcTag = (name: string): string => `${ORIGIN}/alice/tagsfeed/src/tag/${name}`;
    const releaseTag = `${ORIGIN}/alice/tagsfeed/releases/tag/v1.0.0`;
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">`,
      `  <title>Tags for alice/tagsfeed</title>`,
      `  <id>${ORIGIN}/alice/tagsfeed/tags</id>`,
      `  <updated>${formatRfc3339(data!.generatedUnix)}</updated>`,
      `  <subtitle>A &#34;tag&#34; repo &lt;feed&gt;</subtitle>`,
      `  <link href="${ORIGIN}/alice/tagsfeed/tags"></link>`,
      `  <entry>`,
      `    <title>v0.1.0</title>`,
      `    <updated>1970-01-01T00:00:00Z</updated>`,
      `    <id>0: ${srcTag("v0.1.0")}</id>`,
      `    <link href="${srcTag("v0.1.0")}" rel="alternate"></link>`,
      `  </entry>`,
      `  <entry>`,
      `    <title>v0.5.0</title>`,
      `    <updated>2023-11-14T22:43:20Z</updated>`,
      `    <id>${fixture.tagRecordId}: ${srcTag("v0.5.0")}</id>`,
      `    <link href="${srcTag("v0.5.0")}" rel="alternate"></link>`,
      `    <author>`,
      `      <name>Ghost</name>`,
      `    </author>`,
      `  </entry>`,
      `  <entry>`,
      `    <title>v0.9.0</title>`,
      `    <updated>1970-01-01T00:00:00Z</updated>`,
      `    <id>0: ${srcTag("v0.9.0")}</id>`,
      `    <link href="${srcTag("v0.9.0")}" rel="alternate"></link>`,
      `  </entry>`,
      `  <entry>`,
      `    <title>R&amp;D &lt;v1&gt; &#34;one&#34;</title>`,
      `    <updated>2023-11-14T22:13:20Z</updated>`,
      `    <id>${fixture.releaseRowId}: ${releaseTag}</id>`,
      `    <content type="html">&lt;p&gt;Notes &lt;strong&gt;bold&lt;/strong&gt; here&lt;/p&gt;&#xA;</content>`,
      `    <link href="${releaseTag}" rel="alternate"></link>`,
      `    <author>`,
      `      <name>alice</name>`,
      `      <email>alice@example.com</email>`,
      `    </author>`,
      `  </entry>`,
      `</feed>`,
    ].join("\n");
    expect(atom).toBe(expected);

    // The draft exclusion.
    expect(atom).not.toContain("Sneaky draft");

    // The empty-description arm: RSS keeps the empty element, Atom drops
    // the <subtitle> (the omitempty posture).
    const noDescription = renderTagsFeedAtom({ ...data!, description: "" });
    expect(noDescription).not.toContain("<subtitle>");
    expect(renderTagsFeedRss({ ...data!, description: "" })).toContain(
      `    <description></description>`,
    );
  });

  it("empty repo → null (MustBeNotEmpty), answered before any engine read", async () => {
    expect(
      await loadTagsFeedData(env, env.DB, await repoRow(EMPTY_REPO_ID), ORIGIN),
    ).toBeNull();
  });

  it("canReadReleases=false (the releases unit disabled): TagName titles, /src/tag links, no content, authors kept", async () => {
    // The tags group's gate is reqUnitCodeReader (web.go:1502) — a
    // releases-disabled repo still serves; the projection degrades
    // instead (convert.go:294-296).
    await env.DB.prepare("UPDATE repo_settings SET has_releases = 0 WHERE repo_id = ?")
      .bind(fixture.repo.id)
      .run();

    const data = await loadTagsFeedData(env, env.DB, fixture.repo, ORIGIN);
    expect(data).not.toBeNull();
    // EVERY title reverts to the tag name (the release title never leaks);
    // every link is the else-arm target; no content renders.
    expect(data?.items.map((item) => [item.title, item.link, item.content])).toEqual([
      ["v0.1.0", `${ORIGIN}/alice/tagsfeed/src/tag/v0.1.0`, ""],
      ["v0.5.0", `${ORIGIN}/alice/tagsfeed/src/tag/v0.5.0`, ""],
      ["v0.9.0", `${ORIGIN}/alice/tagsfeed/src/tag/v0.9.0`, ""],
      ["v1.0.0", `${ORIGIN}/alice/tagsfeed/src/tag/v1.0.0`, ""],
    ]);
    // Authors are set OUTSIDE the branch (convert.go:306-309): the
    // release row's alice and the tag record's ghost still render.
    expect(data?.items.map((item) => item.authorName)).toEqual(["", "Ghost", "", "alice"]);

    // The rendered RSS: no content:encoded anywhere, ids re-keyed onto
    // the /src/tag links.
    const rss = renderTagsFeedRss(data!);
    expect(rss).not.toContain("<content:encoded>");
    expect(rss).toContain(`      <guid>${fixture.releaseRowId}: ${ORIGIN}/alice/tagsfeed/src/tag/v1.0.0</guid>`);
    expect(rss).toContain(`      <author>alice</author>`);
  });
});
