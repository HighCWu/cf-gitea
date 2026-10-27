/**
 * releases-feed-xml smoke — the wave-releases-feeds bench row, PORT-FIRST
 * gates (the twin user-feed-xml.smoke.test.ts's shape): real seeded data →
 * byte-exact documents, no test matrix (the polish wave owns the remaining
 * arms — the module doc's reductions section carries their cites).
 *
 *   1. RSS: `loadReleasesFeedData` over a seeded public repo (one stable +
 *      one PRERELEASE release, a draft and a tag record alongside) as data
 *      only → `renderReleasesFeedRss` → the full document compared
 *      byte-for-byte against the verified gorilla/feeds v1.2.0 shape for
 *      the releases projection (channel fields incl. the `/release`
 *      singular quirk, the ALWAYS-empty `<description>`, the CDATA note,
 *      the bare `<guid>` — NO isPermaLink attr) — drafts and tag records
 *      excluded, the prerelease included.
 *   2. Atom: the same fixtures → `renderReleasesFeedAtom` → the full
 *      document byte-for-byte (no `<summary>` ever, the author email,
 *      the `<subtitle>` over the raw description) + a builder-level
 *      empty-description arm (subtitle drops).
 *   3. The `repo.MustBeNotEmpty` arm: an empty repo → `null` (the route
 *      404-shells); plus the ghost-publisher arm (a release whose
 *      publisher has no user row → Author "Ghost" with no email).
 *   4. (The polish wave) The MOUNTED route arms (ui/index.ts's
 *      releasesFeedRoute, upstream web.go:1505-1510): the family content
 *      types over the real router, the releases-unit-disabled 404
 *      (`reqRepoReleaseReader` — web.go:1504's group gate), the empty-repo
 *      gate arm, and the case-exact dotted literal (`releases.RSS` stays
 *      unclaimed → the engine's 404). The tags twin's SERVES-anyway arm
 *      lives in tags-feed-xml.smoke.test.ts — the gate divergence pair.
 *
 * Harness posture: the module functions driven DIRECTLY (the repo-
 * lastcommit-fragment test's convention — the route arm is index-owned;
 * the module doc's HANDOFF NOTE carries the mount recipe), against the
 * real workerd D1 (generated migrations in beforeAll).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories } from "../../db/schema";
import type { RepoRow } from "../ui-context";
import { uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import {
  RELEASES_FEED_CONTENT_TYPES,
  loadReleasesFeedData,
  renderReleasesFeedAtom,
  renderReleasesFeedRss,
} from "./releases-feed-xml";
import { formatRfc1123z, formatRfc3339 } from "./user-feed-xml";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch (a Tuesday)
const ORIGIN = "https://feed.test";
const REPO_ID = "repo-demo";
const EMPTY_REPO_ID = "repo-empty";
const GHOSTY_REPO_ID = "repo-ghosty";

/** The real production router (the user-profile.matrix pattern): parse →
 *  resolveUiSession → the mounted releasesFeedRoute with the synthetic
 *  manifest for the 404 shell's assets. */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchRoute(path: string): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://feed.test${path}`), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}


/** The seeded repositories row (a real `$inferSelect` — no hand-built
 *  literal over the long-tail columns). */
async function repoRow(id: string): Promise<RepoRow> {
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, id)).get();
  if (row === undefined) throw new Error(`fixture missing: ${id}`);
  return row;
}

async function seedBaseFixtures(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, email, created_at) VALUES (1, 'alice', 'alice', NULL, 'alice@example.com', unixepoch())",
  ).run();

  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, is_empty, created_at) VALUES (?, ?, 'alice', 1, 'demo', 'public', 0, unixepoch())",
  )
    .bind(REPO_ID, REPO_ID)
    .run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, is_empty, created_at) VALUES (?, ?, 'alice', 1, 'ghosty', 'public', 0, unixepoch())",
  )
    .bind(GHOSTY_REPO_ID, GHOSTY_REPO_ID)
    .run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, is_empty, created_at) VALUES (?, ?, 'alice', 1, 'hollow', 'public', 1, unixepoch())",
  )
    .bind(EMPTY_REPO_ID, EMPTY_REPO_ID)
    .run();

  // The RAW channel description (the repo_settings store).
  await env.DB.prepare("INSERT INTO repo_settings (repo_id, description) VALUES (?, ?)")
    .bind(REPO_ID, 'A "demo" repo <feed>')
    .run();
}

/** Seed the happy path over the demo repo:
 *  - v2.0.0-rc1 — a PRERELEASE (NOT filtered upstream), newest (T0+3600),
 *    the escaping-exercise title, plain note;
 *  - v1.0.0 — stable (T0), markdown note;
 *  - a DRAFT (is_draft=1 — ToConds' IncludeDrafts-unset arm excludes);
 *  - a TAG RECORD (is_tag=1 — IncludeTags:false excludes).
 *  Insert order gives the rc release the LOWER id (the id DESC tiebreak
 *  stays exercised through the created_unix order alone). */
let rcId = 0;
let stableId = 0;
async function seedHappyPath(): Promise<void> {
  await seedBaseFixtures();
  rcId = await insertRelease(REPO_ID, {
    tagName: "v2.0.0-rc1",
    title: 'R&D <beta> "v2"',
    note: "RC notes",
    isPrerelease: true,
    createdAt: T0 + 3600,
    publishedUnix: T0 + 3600,
  });
  stableId = await insertRelease(REPO_ID, {
    tagName: "v1.0.0",
    title: "First release",
    note: "Notes **bold** here",
    createdAt: T0,
    publishedUnix: T0,
  });
  await insertRelease(REPO_ID, {
    tagName: "v0.9.0-draft",
    title: "Sneaky draft",
    note: "never surfaces",
    isDraft: true,
    createdAt: T0 + 7200,
    publishedUnix: 0,
  });
  await insertRelease(REPO_ID, {
    tagName: "v3.0.0",
    title: "",
    note: "",
    isTag: true,
    createdAt: T0 + 10800,
    publishedUnix: 0,
  });
}

async function insertRelease(
  repoId: string,
  opts: {
    tagName: string;
    title: string;
    note: string;
    isDraft?: boolean;
    isPrerelease?: boolean;
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
      opts.isPrerelease === true ? 1 : 0,
      opts.isTag === true ? 1 : 0,
      opts.createdAt,
      opts.publishedUnix,
    )
    .run();
  return result.meta.last_row_id;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["releases", "repo_settings", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  rcId = 0;
  stableId = 0;
});

// --- the two envelopes ---------------------------------------------------------

describe("releases feed xml envelopes (the /{owner}/{repo}/releases.rss + .atom byte surfaces)", () => {
  it("RSS: seeded releases → the gorilla WriteRss document, drafts + tag records excluded, prerelease included", async () => {
    await seedHappyPath();

    const data = await loadReleasesFeedData(env.DB, await repoRow(REPO_ID), ORIGIN);
    expect(data).not.toBeNull();
    expect(data?.items).toHaveLength(2); // newest first: the rc, then v1
    expect(data?.title).toBe("Releases for alice/demo");
    expect(data?.link).toBe(`${ORIGIN}/alice/demo/release`); // the upstream singular quirk
    expect(data?.description).toBe('A "demo" repo <feed>'); // RAW — no markdown render

    expect(RELEASES_FEED_CONTENT_TYPES.rss).toBe("application/rss+xml;charset=utf-8");

    const rss = renderReleasesFeedRss(data!);

    // The full document, byte-for-byte (the generated pubDate interpolated).
    // Note the RELEASE-ITEM deltas vs the action-feed envelope: the always
    // present empty <description>, the bare <guid> (no isPermaLink attr).
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
      `  <channel>`,
      `    <title>Releases for alice/demo</title>`,
      `    <link>https://feed.test/alice/demo/release</link>`,
      `    <description>A &#34;demo&#34; repo &lt;feed&gt;</description>`,
      `    <pubDate>${formatRfc1123z(data!.generatedUnix)}</pubDate>`,
      `    <item>`,
      `      <title>R&amp;D &lt;beta&gt; &#34;v2&#34;</title>`,
      `      <link>https://feed.test/alice/demo/releases/tag/v2.0.0-rc1</link>`,
      `      <description></description>`,
      `      <content:encoded><![CDATA[<p>RC notes</p>`,
      `]]></content:encoded>`,
      `      <author>alice</author>`,
      `      <guid>${rcId}: https://feed.test/alice/demo/releases/tag/v2.0.0-rc1</guid>`,
      `      <pubDate>Tue, 14 Nov 2023 23:13:20 +0000</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>First release</title>`,
      `      <link>https://feed.test/alice/demo/releases/tag/v1.0.0</link>`,
      `      <description></description>`,
      `      <content:encoded><![CDATA[<p>Notes <strong>bold</strong> here</p>`,
      `]]></content:encoded>`,
      `      <author>alice</author>`,
      `      <guid>${stableId}: https://feed.test/alice/demo/releases/tag/v1.0.0</guid>`,
      `      <pubDate>Tue, 14 Nov 2023 22:13:20 +0000</pubDate>`,
      `    </item>`,
      `  </channel>`,
      `</rss>`,
    ].join("\n");
    expect(rss).toBe(expected);

    // The draft + tag-record exclusion: neither surfaces anywhere.
    expect(rss).not.toContain("Sneaky draft");
    expect(rss).not.toContain("v0.9.0-draft");
    expect(rss).not.toContain("v3.0.0");
  });

  it("Atom: seeded releases → the gorilla WriteAtom document (no summary ever, the author email), subtitle arm", async () => {
    await seedHappyPath();

    const data = await loadReleasesFeedData(env.DB, await repoRow(REPO_ID), ORIGIN);
    expect(data).not.toBeNull();

    expect(RELEASES_FEED_CONTENT_TYPES.atom).toBe("application/atom+xml;charset=utf-8");

    const atom = renderReleasesFeedAtom(data!);

    // The full document, byte-for-byte. No <summary> element exists —
    // release items never set a description upstream.
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">`,
      `  <title>Releases for alice/demo</title>`,
      `  <id>https://feed.test/alice/demo/release</id>`,
      `  <updated>${formatRfc3339(data!.generatedUnix)}</updated>`,
      `  <subtitle>A &#34;demo&#34; repo &lt;feed&gt;</subtitle>`,
      `  <link href="https://feed.test/alice/demo/release"></link>`,
      `  <entry>`,
      `    <title>R&amp;D &lt;beta&gt; &#34;v2&#34;</title>`,
      `    <updated>2023-11-14T23:13:20Z</updated>`,
      `    <id>${rcId}: https://feed.test/alice/demo/releases/tag/v2.0.0-rc1</id>`,
      `    <content type="html">&lt;p&gt;RC notes&lt;/p&gt;&#xA;</content>`,
      `    <link href="https://feed.test/alice/demo/releases/tag/v2.0.0-rc1" rel="alternate"></link>`,
      `    <author>`,
      `      <name>alice</name>`,
      `      <email>alice@example.com</email>`,
      `    </author>`,
      `  </entry>`,
      `  <entry>`,
      `    <title>First release</title>`,
      `    <updated>2023-11-14T22:13:20Z</updated>`,
      `    <id>${stableId}: https://feed.test/alice/demo/releases/tag/v1.0.0</id>`,
      `    <content type="html">&lt;p&gt;Notes &lt;strong&gt;bold&lt;/strong&gt; here&lt;/p&gt;&#xA;</content>`,
      `    <link href="https://feed.test/alice/demo/releases/tag/v1.0.0" rel="alternate"></link>`,
      `    <author>`,
      `      <name>alice</name>`,
      `      <email>alice@example.com</email>`,
      `    </author>`,
      `  </entry>`,
      `</feed>`,
    ].join("\n");
    expect(atom).toBe(expected);

    // The draft + tag-record exclusion.
    expect(atom).not.toContain("Sneaky draft");
    expect(atom).not.toContain("v3.0.0");

    // The empty-description arm: RSS keeps the empty element, Atom drops
    // the <subtitle> (the omitempty posture).
    const noDescription = renderReleasesFeedAtom({ ...data!, description: "" });
    expect(noDescription).not.toContain("<subtitle>");
    expect(renderReleasesFeedRss({ ...data!, description: "" })).toContain(
      `    <description></description>`,
    );
  });

  it("empty repo → null (MustBeNotEmpty); a missing publisher renders the ghost (no email)", async () => {
    // The MustBeNotEmpty arm: an EMPTY repo answers null — the route's
    // releasesReadGate 404-shells it (the module doc's HANDOFF NOTE).
    await seedBaseFixtures();
    expect(await loadReleasesFeedData(env.DB, await repoRow(EMPTY_REPO_ID), ORIGIN)).toBeNull();

    // The ghost-publisher arm (LoadAttributes' NewGhostUser): a release
    // whose publisherId has no user row authors "Ghost" with no email —
    // the RSS <author> keeps the name, the Atom author block drops the
    // <email> element.
    await insertRelease(GHOSTY_REPO_ID, {
      tagName: "vX",
      title: "Ghosted",
      note: "",
      publisherId: 4242,
      createdAt: T0,
      publishedUnix: T0,
    });
    const ghosty = await loadReleasesFeedData(env.DB, await repoRow(GHOSTY_REPO_ID), ORIGIN);
    expect(ghosty).not.toBeNull();
    expect(ghosty?.items).toHaveLength(1);
    expect(ghosty?.items[0]?.authorName).toBe("Ghost");
    expect(ghosty?.items[0]?.authorEmail).toBe("");

    const ghostRss = renderReleasesFeedRss(ghosty!);
    expect(ghostRss).toContain("      <author>Ghost</author>");
    const ghostAtom = renderReleasesFeedAtom(ghosty!);
    expect(ghostAtom).toContain("    <author>\n      <name>Ghost</name>\n    </author>");
    expect(ghostAtom).not.toContain("<email>");
    // The empty note renders no content element on either envelope.
    expect(ghostRss).not.toContain("<content:encoded>");
    expect(ghostAtom).not.toContain(`<content type="html">`);
  });
});

// --- the mounted route arms (web.go:1505-1510's gates over the REAL router) ----

describe("the mounted /{owner}/{repo}/releases.rss|.atom route arms", () => {
  it("the public repo's channel answers with the family content type and the loader's body", async () => {
    await seedHappyPath();

    const rss = await fetchRoute("/alice/demo/releases.rss");
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toBe(RELEASES_FEED_CONTENT_TYPES.rss);
    const body = await rss.text();
    expect(body).toContain("<title>Releases for alice/demo</title>");
    expect(body).toContain(`<guid>${rcId}: https://feed.test/alice/demo/releases/tag/v2.0.0-rc1</guid>`);
    expect(body).not.toContain("Sneaky draft"); // the route serves the same draft-free projection

    const atom = await fetchRoute("/alice/demo/releases.atom");
    expect(atom.status).toBe(200);
    expect(atom.headers.get("content-type")).toBe(RELEASES_FEED_CONTENT_TYPES.atom);
    expect(await atom.text()).toContain("<entry>");
  });

  it("the releases unit disabled → the route 404-shells (reqRepoReleaseReader, web.go:1504's group gate)", async () => {
    await seedBaseFixtures();
    await env.DB.prepare("UPDATE repo_settings SET has_releases = 0 WHERE repo_id = ?").bind(REPO_ID).run();

    for (const tail of ["releases.rss", "releases.atom"]) {
      const res = await fetchRoute(`/alice/demo/${tail}`);
      expect(res.status, tail).toBe(404); // upstream CanRead(TypeReleases) false — the invisible shell
      expect(await res.text(), tail).toContain("Page Not Found");
    }
  });

  it("the empty repo → the gate's MustBeNotEmpty arm 404s before any handler body", async () => {
    await seedBaseFixtures(); // 'hollow' is the is_empty=1 row
    const res = await fetchRoute("/alice/hollow/releases.rss");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page Not Found");
  });

  it("the dotted literal is case-exact: releases.RSS stays unclaimed (the engine's 404, upstream's pattern miss)", async () => {
    await seedBaseFixtures();
    for (const tail of ["releases.RSS", "releases.Atom", "releases.rss.txt"]) {
      const res = await fetchRoute(`/alice/demo/${tail}`);
      expect(res.status, tail).toBe(404);
    }
  });
});
