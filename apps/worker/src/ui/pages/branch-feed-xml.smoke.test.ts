/**
 * branch-feed-xml smoke — census gap #10(b), PORT-FIRST gates (the
 * tags-feed twin's shape): real seeded data → byte-exact documents, no
 * test matrix (the polish wave owns the remaining arms — the module doc's
 * reductions section carries their cites).
 *
 *   1. RSS: `loadBranchFeedData` over a REAL pushed repo (three commits on
 *      main: a multi-line message, an escaping-exercise subject with a
 *      distinct author identity, a plain tip) → `renderBranchFeedRss` →
 *      the full document byte-for-byte against the verified gorilla/feeds
 *      v1.2.0 shape for the commit projection (channel fields incl. the
 *      plain-literal title and the `/branch/` link, the FULL-message
 *      `<description>` with the trailing newline as `&#xA;`, the CDATA
 *      body keeping it raw, the BARE `<guid>` — NO isPermaLink attr, the
 *      commit-author name only, the COMMITTER-time pubDate) — newest
 *      first, fixed clock.
 *   2. Atom: the same data → `renderBranchFeedAtom` → the full document
 *      byte-for-byte (the commit family's `<summary type="html">` beside
 *      the content — the release twins never render one; the author
 *      name+email; the plain-oid id) + a builder-level empty-description
 *      arm (subtitle drops).
 *   3. The per-branch universe: a side branch at an earlier tip carries
 *      only ITS ancestors, its own title/link; a slash-named branch keeps
 *      the slash through PathEscapeSegments in the channel link.
 *   4. The fixed page size: eleven commits → exactly ten items
 *      (`BRANCH_FEED_PAGE_SIZE`, branch.go:23's CommitsByRange(0, 10) —
 *      no page param exists on the route).
 *   5. The null arms: an unknown branch → null (upstream RepoRefByType's
 *      middleware 404 — the group carries NO MustBeNotEmpty; the empty
 *      repo answers through the same arm) — the route 404-shells.
 *
 * Harness posture: the module functions driven DIRECTLY (the tags twin's
 * convention — the route arm is index-owned; the module doc's route-seam
 * section carries the mount recipe), against the real workerd bindings
 * (D1 + the REPO cell — the branch universe is pushed content via the
 * landed receive flow, the seed-repo helper plus a local extra-branch
 * push, the branches matrix's pushRefs pattern).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";
import {
  BRANCH_FEED_PAGE_SIZE,
  BRANCH_FEED_CONTENT_TYPES,
  loadBranchFeedData,
  renderBranchFeedAtom,
  renderBranchFeedRss,
} from "./branch-feed-xml";
import { formatRfc1123z, formatRfc3339 } from "./user-feed-xml";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch
const FIXED_NOW = T0 + 9999; // the pinned channel clock
const ORIGIN = "https://feed.test";
const OWNER = "alice";
const SLUG = "branchfeed";
const BIG_SLUG = "branchfeedbig";
const EMPTY_REPO_ID = "repo-empty-branchfeed";

/** Three main-line commits: root (multi-line message), escaping exercise
 *  (distinct author), plain tip (default identity). Fixed times/contents →
 *  deterministic oids. */
const SEED_COMMITS: SeedCommit[] = [
  {
    message: "branchfeed smoke: root commit\n\nbody line here",
    time: T0,
    files: [{ path: "README.md", content: "root\n" }],
  },
  {
    message: 'branchfeed: "quote" & <angle> subject',
    time: T0 + 60,
    author: { name: "Feedy Author", email: "feedy@example.com" },
    files: [{ path: "f1.txt", content: "one\n" }],
  },
  {
    message: "branchfeed: main tip",
    time: T0 + 120,
    files: [{ path: "f2.txt", content: "two\n" }],
  },
];

/** Eleven one-file commits for the page-size repo (the tenth-oldest must
 *  drop). */
const BIG_COMMITS: SeedCommit[] = Array.from({ length: 11 }, (_, index) => ({
  message: `big: commit ${index}`,
  time: T0 + index * 10,
  files: [{ path: `f${index}.txt`, content: `${index}\n` }],
}));

/** Idempotent extra-branch pushes (the branches matrix's pushRefs
 *  pattern): `topic` at tips[1], `feat/x` at tips[0]. */
async function pushBranches(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array): Promise<void> {
  const db = drizzle(env.DB);
  const owner = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!;
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, `branchfeed-seed-${repoName}`)
    .run();
  const token = (await mintFor(owner.id, `branchfeed-seed-${repoName}`, "write:repository")).plaintext;
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`branchfeed seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

interface BranchFeedFixture {
  repo: RepoRow;
  tips: string[];
}

async function repoRow(where: { ownerNamespace: string; slug: string }): Promise<RepoRow> {
  const row = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, where.ownerNamespace), eq(repositories.slug, where.slug)))
    .get();
  if (row === undefined) throw new Error(`fixture missing: ${where.ownerNamespace}/${where.slug}`);
  return row;
}

async function seedEmptyRepoRow(): Promise<void> {
  const main = await repoRow({ ownerNamespace: OWNER, slug: SLUG });
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, is_empty, created_at) VALUES (?, ?, ?, ?, 'hollow-branchfeed', 'public', 1, unixepoch())",
  )
    .bind(EMPTY_REPO_ID, EMPTY_REPO_ID, main.ownerNamespace, main.ownerId)
    .run();
}

/**
 * The idempotent fixture: the REAL pushed repo (main at tips[2], `topic`
 * at tips[1], `feat/x` at tips[0] through the receive flow), the eleven
 * commit page-size repo, the RAW channel description, and the D1-only
 * empty repo row. Repo-scoped rows are wiped per call so repeated runs
 * (rolled back or not) stay consistent.
 */
async function seedFixture(): Promise<BranchFeedFixture> {
  const seeded = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  await ensureSeededRepo({ owner: OWNER, slug: BIG_SLUG, commits: BIG_COMMITS });

  // The extra branches (the engine refs are the universe — the receive
  // flow pushes them only when the main push above created the cell; on a
  // warm fixture the tips equality check keeps it idempotent).
  const repo = await repoRow({ ownerNamespace: OWNER, slug: SLUG });
  const cell = env.REPO.getByName(`${OWNER}/${SLUG}`);
  const existing = new Set((await cell.listRefs()).refs.map((ref) => ref.name));
  if (!existing.has("refs/heads/topic") || !existing.has("refs/heads/feat/x")) {
    const { tips, pack } = await buildHistoryPack(SEED_COMMITS);
    await pushBranches(
      `${OWNER}/${SLUG}`,
      [
        { ref: "refs/heads/topic", oid: tips[1] as string },
        { ref: "refs/heads/feat/x", oid: tips[0] as string },
      ],
      pack,
    );
  }

  await env.DB.prepare("DELETE FROM repo_settings WHERE repo_id = ? OR repo_id = ?").bind(repo.id, EMPTY_REPO_ID).run();
  await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(EMPTY_REPO_ID).run();
  // The RAW channel description (the repo_settings store).
  await env.DB.prepare("INSERT INTO repo_settings (repo_id, description) VALUES (?, ?)")
    .bind(repo.id, 'A "branch" repo <feed>')
    .run();
  await seedEmptyRepoRow();

  return { repo, tips: seeded.tips };
}

let fixture: BranchFeedFixture;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = await seedFixture();
});

// --- the two envelopes ---------------------------------------------------------

describe("branch feed xml envelopes (the /{owner}/{repo}/(rss|atom)/branch/{name} byte surfaces)", () => {
  it("RSS: main's newest three commits → the gorilla WriteRss document (full-message description, bare guid, commit author)", async () => {
    const data = await loadBranchFeedData(env, env.DB, fixture.repo, "main", ORIGIN, new Date(FIXED_NOW * 1000));
    expect(data).not.toBeNull();
    expect(data?.title).toBe("Latest commits for branch main"); // the plain literal — no locale string
    expect(data?.link).toBe(`${ORIGIN}/alice/branchfeed/branch/main`); // RefTypeNameSubURL
    expect(data?.description).toBe('A "branch" repo <feed>'); // RAW — no markdown render
    expect(data?.generatedUnix).toBe(FIXED_NOW);
    expect(data?.items.map((item) => item.title)).toEqual([
      "branchfeed: main tip",
      'branchfeed: "quote" & <angle> subject', // the trimmed first line — the MessageTitle chain
      "branchfeed smoke: root commit", // the multi-line message's subject
    ]);
    // The full-message arms: the trailing newline git stores rides along
    // in BOTH description and content; the commit author (not a user row).
    expect(data?.items.map((item) => item.description)).toEqual([
      "branchfeed: main tip\n",
      'branchfeed: "quote" & <angle> subject\n',
      "branchfeed smoke: root commit\n\nbody line here\n",
    ]);
    expect(data?.items.map((item) => item.authorName)).toEqual(["Test User", "Feedy Author", "Test User"]);
    expect(data?.items.map((item) => item.createdUnix)).toEqual([T0 + 120, T0 + 60, T0]);

    expect(BRANCH_FEED_CONTENT_TYPES.rss).toBe("application/rss+xml;charset=utf-8");

    const rss = renderBranchFeedRss(data!);
    const [root, escaped, tip] = fixture.tips as [string, string, string];
    const commitHref = (oid: string): string => `${ORIGIN}/alice/branchfeed/commit/${oid}`;
    // The full document, byte-for-byte (the generated pubDate interpolated).
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
      `  <channel>`,
      `    <title>Latest commits for branch main</title>`,
      `    <link>${ORIGIN}/alice/branchfeed/branch/main</link>`,
      `    <description>A &#34;branch&#34; repo &lt;feed&gt;</description>`,
      `    <pubDate>${formatRfc1123z(FIXED_NOW)}</pubDate>`,
      `    <item>`,
      `      <title>branchfeed: main tip</title>`,
      `      <link>${commitHref(tip)}</link>`,
      `      <description>branchfeed: main tip&#xA;</description>`,
      `      <content:encoded><![CDATA[branchfeed: main tip\n]]></content:encoded>`,
      `      <author>Test User</author>`,
      `      <guid>${tip}</guid>`, // the BARE guid — no isPermaLink attr on this family
      `      <pubDate>${formatRfc1123z(T0 + 120)}</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>branchfeed: &#34;quote&#34; &amp; &lt;angle&gt; subject</title>`,
      `      <link>${commitHref(escaped)}</link>`,
      `      <description>branchfeed: &#34;quote&#34; &amp; &lt;angle&gt; subject&#xA;</description>`,
      `      <content:encoded><![CDATA[branchfeed: "quote" & <angle> subject\n]]></content:encoded>`,
      `      <author>Feedy Author</author>`,
      `      <guid>${escaped}</guid>`,
      `      <pubDate>${formatRfc1123z(T0 + 60)}</pubDate>`,
      `    </item>`,
      `    <item>`,
      `      <title>branchfeed smoke: root commit</title>`,
      `      <link>${commitHref(root)}</link>`,
      `      <description>branchfeed smoke: root commit&#xA;&#xA;body line here&#xA;</description>`,
      `      <content:encoded><![CDATA[branchfeed smoke: root commit\n\nbody line here\n]]></content:encoded>`,
      `      <author>Test User</author>`,
      `      <guid>${root}</guid>`,
      `      <pubDate>${formatRfc1123z(T0)}</pubDate>`,
      `    </item>`,
      `  </channel>`,
      `</rss>`,
    ].join("\n");
    expect(rss).toBe(expected);
  });

  it("Atom: the same commits → the gorilla WriteAtom document (summary + content arms, name+email author), subtitle arm", async () => {
    const data = await loadBranchFeedData(env, env.DB, fixture.repo, "main", ORIGIN, new Date(FIXED_NOW * 1000));
    expect(data).not.toBeNull();

    expect(BRANCH_FEED_CONTENT_TYPES.atom).toBe("application/atom+xml;charset=utf-8");

    const atom = renderBranchFeedAtom(data!);
    const [root, escaped, tip] = fixture.tips as [string, string, string];
    const commitHref = (oid: string): string => `${ORIGIN}/alice/branchfeed/commit/${oid}`;
    // The full document, byte-for-byte. The commit family's summary arm:
    // BOTH <summary> and <content> render (the release twins never set a
    // description upstream — this family does, branch.go:44-45).
    const entry = (title: string, oid: string, message: string, when: number, author: string, email: string | null): string[] => [
      `  <entry>`,
      `    <title>${title}</title>`,
      `    <updated>${formatRfc3339(when)}</updated>`,
      `    <id>${oid}</id>`, // the plain oid — NOT the twins' "%v: %v" shape
      `    <content type="html">${message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&#34;")
        .replace(/\n/g, "&#xA;")}</content>`,
      `    <link href="${commitHref(oid)}" rel="alternate"></link>`,
      `    <summary type="html">${message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&#34;")
        .replace(/\n/g, "&#xA;")}</summary>`,
      ...(email === null
        ? [`    <author>`, `      <name>${author}</name>`, `    </author>`]
        : [`    <author>`, `      <name>${author}</name>`, `      <email>${email}</email>`, `    </author>`]),
      `  </entry>`,
    ];
    const esc = (s: string): string =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");
    const expected = [
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">`,
      `  <title>Latest commits for branch main</title>`,
      `  <id>${ORIGIN}/alice/branchfeed/branch/main</id>`,
      `  <updated>${formatRfc3339(FIXED_NOW)}</updated>`,
      `  <subtitle>A &#34;branch&#34; repo &lt;feed&gt;</subtitle>`,
      `  <link href="${ORIGIN}/alice/branchfeed/branch/main"></link>`,
      ...entry(esc("branchfeed: main tip"), tip, "branchfeed: main tip\n", T0 + 120, "Test User", "test@example.com"),
      ...entry(
        esc('branchfeed: "quote" & <angle> subject'),
        escaped,
        'branchfeed: "quote" & <angle> subject\n',
        T0 + 60,
        "Feedy Author",
        "feedy@example.com",
      ),
      ...entry(esc("branchfeed smoke: root commit"), root, "branchfeed smoke: root commit\n\nbody line here\n", T0, "Test User", "test@example.com"),
      `</feed>`,
    ].join("\n");
    expect(atom).toBe(expected);

    // The empty-description arm: RSS keeps the empty element, Atom drops
    // the <subtitle> (the omitempty posture).
    const noDescription = renderBranchFeedAtom({ ...data!, description: "" });
    expect(noDescription).not.toContain("<subtitle>");
    expect(renderBranchFeedRss({ ...data!, description: "" })).toContain(`    <description></description>`);
  });

  it("per-branch universes: a side branch carries only its ancestors; the slash name keeps the slash in the channel link", async () => {
    const topic = await loadBranchFeedData(env, env.DB, fixture.repo, "topic", ORIGIN, new Date(FIXED_NOW * 1000));
    expect(topic?.title).toBe("Latest commits for branch topic");
    expect(topic?.link).toBe(`${ORIGIN}/alice/branchfeed/branch/topic`);
    expect(topic?.items.map((item) => item.title)).toEqual([
      'branchfeed: "quote" & <angle> subject',
      "branchfeed smoke: root commit",
    ]);

    const slash = await loadBranchFeedData(env, env.DB, fixture.repo, "feat/x", ORIGIN, new Date(FIXED_NOW * 1000));
    expect(slash?.link).toBe(`${ORIGIN}/alice/branchfeed/branch/feat/x`); // PathEscapeSegments keeps the slash
    expect(slash?.items.map((item) => item.title)).toEqual(["branchfeed smoke: root commit"]);
    const rss = renderBranchFeedRss(slash!);
    expect(rss).toContain(`<link>${ORIGIN}/alice/branchfeed/branch/feat/x</link>`);
  });

  it("page size: eleven commits → exactly ten items (branch.go:23's CommitsByRange(0, 10))", async () => {
    const big = await repoRow({ ownerNamespace: OWNER, slug: BIG_SLUG });
    const data = await loadBranchFeedData(env, env.DB, big, "main", ORIGIN, new Date(FIXED_NOW * 1000));
    expect(data?.items).toHaveLength(BRANCH_FEED_PAGE_SIZE);
    expect(BRANCH_FEED_PAGE_SIZE).toBe(10);
    // The newest ten: the root commit (big: commit 0) drops off the end.
    expect(data?.items[0]?.title).toBe("big: commit 10");
    expect(data?.items[9]?.title).toBe("big: commit 1");
    expect(data?.items.map((item) => item.title)).not.toContain("big: commit 0");
  });

  it("null arms: an unknown branch and an empty repo → null (the route 404-shells — RepoRefByType's arm, no MustBeNotEmpty here)", async () => {
    expect(
      await loadBranchFeedData(env, env.DB, fixture.repo, "ghost", ORIGIN, new Date(FIXED_NOW * 1000)),
    ).toBeNull();
    const empty = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, EMPTY_REPO_ID)).get();
    expect(empty).toBeDefined();
    expect(
      await loadBranchFeedData(env, env.DB, empty!, "main", ORIGIN, new Date(FIXED_NOW * 1000)),
    ).toBeNull(); // no refs exist to resolve — the same unknown-branch arm
  });
});
