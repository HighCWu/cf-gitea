/**
 * Wave-46 fragment mounts — the machinery waves' routes landing (the parity
 * survey row-5 skips retiring):
 *
 * - `GET /{owner}/{repo}/lastcommit/*` (web.go:1761) — the
 *   pages/repo-lastcommit-fragment.tsx route handoff mounted in index.ts;
 * - `GET /{owner}/{repo}/blob_excerpt/{sha}` (web.go:1735) +
 *   `GET /{owner}/{repo}/wiki/blob_excerpt/{sha}` (web.go:1618) — the
 *   blob-excerpt machinery's stage 3 (pages/repo-blob-excerpt-fragment.tsx):
 *   the tplBlobExcerpt `<tr>` rows over BuildBlobExcerptDiffSection, the
 *   RenderBlobExcerptButtons round-trip, the wiki cell swap;
 * - the components/file-list.tsx data-fetch flip (the lastcommit machinery's
 *   open 2 — view_list.tmpl:3-8's HasFilesWithoutLatestCommit arm).
 *
 * Same harness posture as pages-wave39: the router driven directly with the
 * synthetic ASSETS manifest; engine content seeds through the REAL receive
 * flow with fixed timestamps. Fixture repos `alice/wave46frag` (one commit:
 * the 50-line excerpt.txt + README.md + docs/guide.md) and
 * `alice/wave46empty` (never pushed — the empty-repo arms, its wiki twin
 * proving the wiki arm has no MustBeNotEmpty gate).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { createWikiPage, wikiCellName } from "../../services/wiki";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { engineReads } from "../../api/services/engine";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { RepoFilesTable } from "../components/file-list";
import { ensureSeededRepo } from "../testing/seed-repo";
import { uiEnv } from "./harness";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

/** HashFilePathForWebUI's test-vector algorithm (modules/git/utils.go:42-46). */
async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- fixtures -----------------------------------------------------------------

const T0 = 1_700_000_000;

const EXCERPT_LINES = Array.from({ length: 50 }, (_unused, i) => `line-${i + 1}`);
const WIKI_LINES = Array.from({ length: 50 }, (_unused, i) => `wiki-line-${i + 1}`);

const WAVE46_COMMITS = [
  {
    message: "wave46: seed the excerpt fixture",
    time: T0,
    files: [
      { path: "excerpt.txt", content: `${EXCERPT_LINES.join("\n")}\n` },
      { path: "README.md", content: "# wave46\n" },
      { path: "docs/guide.md", content: "# wave46 guide\n" },
    ],
  },
];

const FRAG = { owner: "alice", slug: "wave46frag" };
const EMPTY = { owner: "alice", slug: "wave46empty" };

let fragTip = "";
let fragRowId = "";

beforeAll(async () => {
  await applyAuthD1Migrations();
  fragTip = (await ensureSeededRepo({ ...FRAG, commits: WAVE46_COMMITS })).tips[0] as string;

  const db = drizzle(env.DB);
  const fragRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, FRAG.owner), eq(repositories.slug, FRAG.slug)))
    .get();
  if (fragRow === undefined) throw new Error("wave46frag row missing after seed");
  fragRowId = fragRow.id;

  // The never-pushed repo row (the empty arms). The owner row exists — the
  // frag seed made it.
  const alice = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (alice === undefined) throw new Error("alice row missing after seed");
  let emptyRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, EMPTY.owner), eq(repositories.slug, EMPTY.slug)))
    .get();
  if (emptyRow === undefined) {
    emptyRow = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: alice.usernameLower },
      name: EMPTY.slug,
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, emptyRow.id, `${EMPTY.owner}/${EMPTY.slug}`);
  }
  if (emptyRow.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, emptyRow.id));
  }

  // Wiki content on both repos (createWikiPage lands the ROOT commit on the
  // lazy sibling cell — the empty repo's wiki works, which is the point of
  // the twin's no-MustBeNotEmpty gate).
  const doer = { name: "alice", email: "alice@example.com" };
  const origin = "https://test.local";
  const wikiContent = new TextEncoder().encode(`${WIKI_LINES.join("\n")}\n`);
  const emptyRepoRow =
    (await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, EMPTY.owner), eq(repositories.slug, EMPTY.slug)))
      .get()) ?? emptyRow;
  await createWikiPage(env, { repo: fragRow, owner: alice }, doer, { title: "Home", content: wikiContent, message: "" }, origin);
  await createWikiPage(env, { repo: emptyRepoRow, owner: alice }, doer, { title: "Home", content: wikiContent, message: "" }, origin);
});

/** The sibling wiki cell's HEAD tip oid (createWikiPage's commit) —
 *  listRefs' `head` is the symref NAME, the oid rides the refs entries. */
async function wikiTip(owner: string, slug: string): Promise<string> {
  const refs = await engineReads(env, wikiCellName({ ownerNamespace: owner, slug })).listRefs();
  if (refs === null) throw new Error("wiki cell unreadable");
  const main = refs.refs.find((ref) => ref.name === "refs/heads/main");
  if (main === undefined) throw new Error("wiki cell has no main branch");
  return main.target;
}

// --- the parser claims ---------------------------------------------------------

describe("parseUiRoute claims (wave-46 fragment mounts)", () => {
  const sha = "a".repeat(40);

  it("claims the exact blob_excerpt / wiki twin / lastcommit shapes", () => {
    expect(parseUiRoute(`/octo/hello/blob_excerpt/${sha}`)).toEqual({ family: "blob-excerpt", owner: "octo", repo: "hello", sha });
    expect(parseUiRoute("/octo/hello/blob_excerpt/not-even-sha")).toEqual({
      family: "blob-excerpt",
      owner: "octo",
      repo: "hello",
      sha: "not-even-sha",
    });
    expect(parseUiRoute("/octo/hello/wiki/blob_excerpt/deadbeef")).toEqual({
      family: "wiki-blob-excerpt",
      owner: "octo",
      repo: "hello",
      sha: "deadbeef",
    });
    expect(parseUiRoute(`/octo/hello/lastcommit/${sha}/docs/guide.md`)).toEqual({
      family: "lastcommit",
      owner: "octo",
      repo: "hello",
      rawTail: `${sha}/docs/guide.md`,
    });
    // The bare lastcommit URL is chi's empty-tail match (the archive
    // precedent) — claimed, the default-branch arm 404-shells at the handler.
    expect(parseUiRoute("/octo/hello/lastcommit")).toEqual({ family: "lastcommit", owner: "octo", repo: "hello", rawTail: "" });
    expect(handlesUiRoute(`/octo/hello/blob_excerpt/${sha}`)).toBe(true);
    expect(handlesUiRoute("/octo/hello/wiki/blob_excerpt/deadbeef")).toBe(true);
    expect(handlesUiRoute(`/octo/hello/lastcommit/${sha}/src`)).toBe(true);
  });

  it("leaves the space around the shapes engine-owned", () => {
    expect(parseUiRoute("/octo/hello/blob_excerpt")).toBeNull(); // bare → no sha param
    expect(parseUiRoute(`/octo/hello/blob_excerpt/${sha}/extra`)).toBeNull(); // deeper tail
    expect(parseUiRoute("/octo/hello/wiki")).toBeNull(); // no /wiki family this slice
    expect(parseUiRoute("/octo/hello/wiki/blob_excerpt")).toBeNull(); // the twin needs {sha}
    expect(parseUiRoute("/octo/hello/wiki/other/x")).toBeNull(); // the twin claims only blob_excerpt
    expect(parseUiRoute("/octo/hello/wiki/blob_excerpt/dead/beef")).toBeNull(); // single-segment sha
  });
});

// --- the lastcommit route (the machinery handoff's four arms) -------------------

describe("GET /{owner}/{repo}/lastcommit/*", () => {
  it("serves the standalone fragment with the refSubUrl link context", async () => {
    const res = await fetchUi(`/alice/wave46frag/lastcommit/${fragTip}?refSubUrl=branch/main`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const html = await res.text();
    expect(html.startsWith('<div id="repo-files-table">')).toBe(true);
    expect(html).toContain("wave46: seed the excerpt fixture"); // the header box (treeLastCommit = commit)
    expect(html).toContain('href="/alice/wave46frag/src/branch/main/docs"');
    expect(html).toContain('href="/alice/wave46frag/src/branch/main/README.md"');
    expect(html).toContain('<a href="/alice/wave46frag/commit/');
  });

  it("404-shells the pattern miss, the unresolvable sha, and the empty repo", async () => {
    // The default-branch arm (the bare/HEAD tails) — the landed commit-arm
    // convention's documented divergence.
    expect((await fetchUi("/alice/wave46frag/lastcommit")).status).toBe(404);
    expect((await fetchUi(`/alice/wave46frag/lastcommit/HEAD/docs`)).status).toBe(404);
    // A well-formed oid the engine cannot resolve.
    expect((await fetchUi(`/alice/wave46frag/lastcommit/${"f".repeat(40)}`)).status).toBe(404);
    // The never-pushed repo (RepoRefByType's nil-Commit arm).
    expect((await fetchUi(`/alice/wave46empty/lastcommit/${fragTip}`)).status).toBe(404);
  });
});

// --- the blob_excerpt route (the machinery's stage 3) ---------------------------
// The button anchors ride sha1(path) — HashFilePathForWebUI (utils.go:42-46).

describe("GET /{owner}/{repo}/blob_excerpt/{sha}", () => {
  it("full-fill 'up' renders the strictly-between rows and no new expander", async () => {
    const hash = await sha1Hex("excerpt.txt");
    const res = await fetchUi(
      `/alice/wave46frag/blob_excerpt/${fragTip}?style=unified&direction=up&anchor=diff-xK11` +
        `&last_left=0&last_right=0&left=11&right=11&left_hunk_size=20&right_hunk_size=20&path=excerpt.txt&filelang=`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const html = await res.text();
    // Ten plain rows (1..10), the marker-prefixed code-inner text.
    expect((html.match(/<tr class="same-code line-expanded" data-line-type="same">/g) ?? []).length).toBe(10);
    expect(html).toContain("> line-1</code>");
    expect(html).toContain("> line-10</code>");
    expect(html).not.toContain("> line-11</code>");
    // The rel anchors ride the path hash (sha1("excerpt.txt")).
    expect(html).toContain(`rel="diff-${hash}L1"`);
    expect(html).toContain(`rel="diff-${hash}R10"`);
    // The fully-merged hunk: no expander row, no buttons (gitdiff_excerpt.go:101-103).
    expect(html).not.toContain("code-expander-buttons");
    expect(html).not.toContain("code-expander-button");
  });

  it("partial 'down' appends the expander row with the updown button pair", async () => {
    const hash = await sha1Hex("excerpt.txt");
    const res = await fetchUi(
      `/alice/wave46frag/blob_excerpt/${fragTip}?style=unified&direction=down&anchor=diff-xK50` +
        `&last_left=8&last_right=8&left=50&right=50&left_hunk_size=1&right_hunk_size=1&path=excerpt.txt&filelang=`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The window is lines 9..28 (20 rows), then the appended expander.
    expect((html.match(/<tr class="same-code line-expanded" data-line-type="same">/g) ?? []).length).toBe(20);
    expect(html).toContain("> line-9</code>");
    expect(html).toContain("> line-28</code>");
    expect(html).not.toContain("> line-29</code>");
    expect(html).toContain("<tr class=\"tag-code line-expanded\" data-line-type=\"tag\">");
    expect(html).toContain("@@ -50,1 +50,1 @@");
    // GetExpandDirection "updown" → fold-down THEN fold-up (gitdiff.go:255-262).
    expect(html).toContain('<div class="code-expander-buttons" data-expand-direction="updown">');
    const downUrl =
      `/alice/wave46frag/blob_excerpt/${fragTip}?style=unified&amp;direction=down&amp;anchor=diff-${hash}K50` +
      `&amp;last_left=28&amp;last_right=28&amp;left=50&amp;right=50&amp;left_hunk_size=1&amp;right_hunk_size=1` +
      `&amp;path=excerpt.txt&amp;filelang=`;
    expect(html).toContain(`data-fetch-url="${downUrl}"`);
    expect(html).toContain(`direction=up&amp;anchor=diff-${hash}K50`);
    // The empty-IDs form of gitdiff.go:247's `,%s,` format (Join of none).
    expect(html).toContain('data-hidden-comment-ids=",,"');
    expect(html).toContain('class="svg octicon-fold-down"');
    expect(html).toContain('class="svg octicon-fold-up"');
  });

  it("404-shells the empty repo, an unknown sha, and a missing path", async () => {
    expect((await fetchUi(`/alice/wave46empty/blob_excerpt/${fragTip}`)).status).toBe(404);
    expect((await fetchUi(`/alice/wave46frag/blob_excerpt/${"f".repeat(40)}?path=excerpt.txt`)).status).toBe(404);
    expect(
      (
        await fetchUi(
          `/alice/wave46frag/blob_excerpt/${fragTip}?last_left=0&last_right=0&left=11&right=11` +
            `&left_hunk_size=20&right_hunk_size=20&direction=up&path=nope.txt`,
        )
      ).status,
    ).toBe(404);
  });
});

// --- the wiki twin (the cell swap + the MustEnableWiki gate) --------------------

describe("GET /{owner}/{repo}/wiki/blob_excerpt/{sha}", () => {
  it("reads the sibling wiki cell and swaps the buttons' BaseLink", async () => {
    const tip = await wikiTip(FRAG.owner, FRAG.slug);
    const hash = await sha1Hex("Home.md");
    const res = await fetchUi(
      `/alice/wave46frag/wiki/blob_excerpt/${tip}?style=unified&direction=up&anchor=x` +
        `&last_left=0&last_right=0&left=11&right=11&left_hunk_size=20&right_hunk_size=20&path=Home.md&filelang=`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("> wiki-line-1</code>"); // the WIKI cell's bytes, not the repo's
    expect(html).not.toContain("> line-1</code>");
    expect(html).toContain(`rel="diff-${hash}L1"`);

    // The buttons re-target the wiki BaseLink (compare.go:729).
    const partial = await fetchUi(
      `/alice/wave46frag/wiki/blob_excerpt/${tip}?style=unified&direction=down&anchor=x` +
        `&last_left=8&last_right=8&left=50&right=50&left_hunk_size=1&right_hunk_size=1&path=Home.md&filelang=`,
    );
    expect(partial.status).toBe(200);
    expect(await partial.text()).toContain(
      `data-fetch-url="/alice/wave46frag/wiki/blob_excerpt/${tip}?style=unified&amp;direction=down`,
    );
  });

  it("serves an EMPTY main repo's wiki (the twin has no MustBeNotEmpty gate)", async () => {
    const tip = await wikiTip(EMPTY.owner, EMPTY.slug);
    const res = await fetchUi(
      `/alice/wave46empty/wiki/blob_excerpt/${tip}?style=unified&direction=up&anchor=x` +
        `&last_left=0&last_right=0&left=11&right=11&left_hunk_size=20&right_hunk_size=20&path=Home.md&filelang=`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("> wiki-line-1</code>");
  });

  it("404-shells a wiki-disabled repo (MustEnableWiki, web.go:1614)", async () => {
    await saveRepoSettings(env.DB, fragRowId, { hasWiki: false }, new Date(T0 * 1000));
    try {
      const tip = await wikiTip(FRAG.owner, FRAG.slug);
      expect(
        (
          await fetchUi(
            `/alice/wave46frag/wiki/blob_excerpt/${tip}?style=unified&direction=up&anchor=x` +
              `&last_left=0&last_right=0&left=11&right=11&left_hunk_size=20&right_hunk_size=20&path=Home.md&filelang=`,
          )
        ).status,
      ).toBe(404);
      // The repo twin is NOT wiki-gated (web.go:1735's group) — still serves.
      expect(
        (
          await fetchUi(
            `/alice/wave46frag/blob_excerpt/${fragTip}?style=unified&direction=up&anchor=x` +
              `&last_left=0&last_right=0&left=11&right=11&left_hunk_size=20&right_hunk_size=20&path=excerpt.txt&filelang=`,
          )
        ).status,
      ).toBe(200);
    } finally {
      await saveRepoSettings(env.DB, fragRowId, { hasWiki: true }, new Date(T0 * 1000));
    }
  });
});

// --- the file-list flip (view_list.tmpl:3-8's HasFilesWithoutLatestCommit arm) --

const FLIP_ENTRY = { name: "README.md", mode: "100644", type: "blob" as const, oid: "e".repeat(40) };
const FLIP_COMMIT = {
  oid: "c".repeat(40),
  tree: "d".repeat(40),
  parents: [],
  author: { name: "a", email: "a@example.com", time: T0, tz: "+0000" },
  committer: { name: "a", email: "a@example.com", time: T0, tz: "+0000" },
  subject: "flip",
  message: "flip",
};

function renderFlipTable(commits: ReadonlyMap<string, (typeof FLIP_COMMIT) | null>, loaderCommitOid?: string): string {
  return renderToString(
    <RepoFilesTable
      repoLink="/alice/wave46frag"
      refType="branch"
      ref="main"
      dirPath=""
      entries={[FLIP_ENTRY]}
      commits={commits}
      latestCommit={FLIP_COMMIT}
      loaderCommitOid={loaderCommitOid}
    />,
  );
}

describe("RepoFilesTable data-fetch flip (components/file-list.tsx)", () => {
  it("emits the loader attributes when a row stayed notready and the commit is armed", () => {
    const html = renderFlipTable(new Map([["README.md", null]]), FLIP_COMMIT.oid);
    expect(html).toContain('data-fetch-url="/alice/wave46frag/lastcommit/' + FLIP_COMMIT.oid + '/?refSubUrl=branch%2Fmain"');
    expect(html).toContain('data-fetch-trigger="load"');
    expect(html).toContain('data-fetch-sync="$morph"');
    expect(html).toContain('data-fetch-indicator=".repo-file-cell.notready.message"');
    expect(html).toContain("notready");
  });

  it("stays pre-flip without the commit id, or when every row resolved", () => {
    // The machinery module's builder does not pass the id — its fragment
    // keeps the landed no-attrs shape (repo-lastcommit-fragment.test.ts).
    expect(renderFlipTable(new Map([["README.md", null]]))).not.toContain("data-fetch");
    expect(renderFlipTable(new Map([["README.md", FLIP_COMMIT]]), FLIP_COMMIT.oid)).not.toContain("data-fetch");
  });
});
