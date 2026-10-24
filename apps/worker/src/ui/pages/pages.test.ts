/**
 * U3 page render tests (SPEC-0008 §5.1): route-level HTML assertions over the
 * mounted sub-app, with REAL pushed engine content — `ensureSeededRepo`
 * pushes a tiny multi-commit pack through the landed receive flow
 * (testing/seed-repo.ts), so the pages run against actual git objects in the
 * local DO/R2, not stub responses. D1 comes from the generated migrations +
 * the push-created rows (flipped public per §2.5).
 *
 * The ASSETS binding is injected as a synthetic-manifest fetcher (same
 * fixture shape as index.test.ts — the real build output is gitignored, so
 * tests never depend on `pnpm build:assets`). No SELF for the page reads:
 * the tests drive `uiRouter.fetch()` directly (§2.2 keeps src/index.ts
 * orchestrator-owned).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { type UiManifest } from "../manifest";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";

// --- fixtures ----------------------------------------------------------------

/** Synthetic manifest shaped like the real Vite output (deterministic). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    imports: ["web_src/js/secondary.ts"],
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/js/secondary.ts": { file: "js/secondary.2222bbbb.js", css: ["css/secondary.3333cccc.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const fakeAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

type UiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const uiEnv: UiTestEnv = { ...env, ASSETS: fakeAssets };

async function fetchUi(path: string, e: UiTestEnv = uiEnv): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), e);
}

// Deterministic history: commit 1 writes the README, commit 2 everything else
// — so the §3.5 per-entry enrichment resolves DIFFERENT commits per row.
const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z

const README = [
  "# Hello cf-gitea",
  "",
  "Some *markdown* with a [relative link](docs/guide.md).",
  "",
  "## Details",
  "",
  "Plain paragraph.",
  "",
].join("\n");

const APP_TS = [
  "export function main(): void {",
  '  console.log("hello cf-gitea");',
  "}",
  "",
].join("\n");

const GUIDE_MD = ["# Guide", "", "Walkthrough text.", ""].join("\n");

/** Null-byte-leading bytes: the §4.2 binary sniff fires, the .png extension
 *  picks the image media branch. */
const LOGO_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const PAGES_COMMITS: SeedCommit[] = [
  { message: "initial commit: add README", time: T0, files: [{ path: "README.md", content: README }] },
  {
    message: "add app source and docs",
    time: T0 + 120,
    files: [
      { path: "README.md", content: README },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GUIDE_MD },
      { path: "logo.png", content: LOGO_PNG },
    ],
  },
];

const BIG_COMMITS: SeedCommit[] = Array.from({ length: 51 }, (_unused, i) => ({
  message: `commit number ${i + 1}`,
  time: T0 + i * 60,
  files: [{ path: "counter.txt", content: `line ${i + 1}\n` }],
}));

let pagesTips: string[] = [];

beforeAll(async () => {
  await applyAuthD1Migrations();
  const pages = await ensureSeededRepo({
    owner: "alice",
    slug: "pages",
    commits: PAGES_COMMITS,
    tags: [{ name: "v1", commitIndex: 1 }],
  });
  pagesTips = pages.tips;
  await ensureSeededRepo({ owner: "alice", slug: "big", commits: BIG_COMMITS });
});

/** A repo row with no engine content (never pushed): the §4.1 empty render. */
async function seedEmptyRepo(owner: string, slug: string): Promise<void> {
  const existing = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, owner.toLowerCase()))
    .get();
  const user = existing ?? (await seedVerifiedUser({ username: owner }));
  await drizzle(env.DB).insert(repositories).values({
    id: crypto.randomUUID(),
    storageKey: `r_${crypto.randomUUID()}`,
    ownerNamespace: owner.toLowerCase(),
    ownerId: user.id,
    slug: slug.toLowerCase(),
    visibility: "public",
  });
}

// --- home (§5.1: #repo-files-table structure + README markup) -----------------

describe("home page (repo browse)", () => {
  it("renders the file list table with per-entry commit enrichment", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const res = await fetchUi("/alice/pages");
    expect(res.status).toBe(200);

    const html = await res.text();
    // §2.4.1 discriminator + shell.
    expect(html).toContain('<div role="main" aria-label="alice/pages" class="page-content repository file list">');
    expect(html).toContain('<a class="active item" href="/alice/pages" data-shortcut-keys="g c">');

    // §2.4.1: the load-bearing table with last-commit box, NO notready cells
    // and no partial-refresh loader (§3.5 complete-render contract).
    expect(html).toContain('<div id="repo-files-table">');
    expect(html).toContain('<div class="repo-file-line repo-file-last-commit">');
    expect(html).toContain("add app source and docs"); // HEAD subject in the box
    expect(html).not.toContain("notready");
    expect(html).not.toContain("data-fetch-url");

    // Four entries, git tree order (README.md, app.ts, docs/, logo.png).
    const items = html.match(/<div class="repo-file-item">/g) ?? [];
    expect(items).toHaveLength(4);
    expect(html).toContain('<a class="entry-name" href="/alice/pages/src/branch/main/README.md" title="README.md">README.md</a>');
    expect(html).toContain('<a class="entry-name" href="/alice/pages/src/branch/main/app.ts" title="app.ts">app.ts</a>');
    expect(html).toContain('<a class="entry-name" href="/alice/pages/src/branch/main/docs" title="docs">docs</a>');
    // Cell structure: name / message commit-summary / age with relative-time.
    expect(html).toContain('<div class="repo-file-cell name muted-links">');
    expect(html).toContain('<div class="repo-file-cell message commit-summary">');
    expect(html).toContain('<div class="repo-file-cell age">');
    expect(html).toContain('<relative-time prefix="" tense="past" datetime="2023-11-14T22:13:20Z"');

    // §3.5 enrichment resolved DIFFERENT commits per entry: the README row
    // carries commit 1's subject, app.ts commit 2's.
    const readmeRow = html.slice(html.indexOf("README.md</a>"), html.indexOf("app.ts</a>"));
    expect(readmeRow).toContain("initial commit: add README");
    expect(readmeRow).not.toContain("add app source");
  });

  it("renders the README through the shared §3.4 markdown pipeline with link rewriting", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const html = await (await fetchUi("/alice/pages")).text();

    // The §3.4 container + shared-renderer output (slug anchors, relative
    // links rewritten branch-prefixed, images toward the media family —
    // links.ts documents the raw-vs-media URL note, open question 3).
    expect(html).toContain('id="readme"');
    expect(html).toContain('<div class="file-view markup markdown"');
    expect(html).toContain('<h1 id="user-content-hello-cf-gitea">');
    expect(html).toContain("<em>markdown</em>");
    expect(html).toContain('href="https://test.local/alice/pages/src/branch/main/docs/guide.md"');
    expect(html).toContain('<div class="file-header-left');
    expect(html).toContain('<a class="muted" href="#readme">README.md</a>');
  });

  it("renders the branch selector with the repo's branches", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const html = await (await fetchUi("/alice/pages")).text();
    expect(html).toContain('<div class="ui dropdown">');
    expect(html).toContain('<span class="text">main</span>');
    expect(html).toContain('<a class="active item" href="/alice/pages/src/branch/main">main</a>');
  });

  it("renders the §4.1 empty-repo page for an unborn repo (clone command, no file list)", async () => {
    await seedEmptyRepo("alice", "hollow");
    const res = await fetchUi("/alice/hollow");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository quickstart"');
    expect(html).toContain("https://test.local/alice/hollow.git");
    expect(html).toContain("git push -u origin main");
    expect(html).not.toContain("repo-files-table");
    expect(html).not.toContain("readme");
  });

  it("404-shells an unknown repo without repo context (§4.5)", async () => {
    const res = await fetchUi("/nobody/nothing");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain("repo-header");
  });
});

// --- commits (§5.1: commit rows + pagination) ----------------------------------

describe("commits page", () => {
  it("renders the commit log rows in upstream shape", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const res = await fetchUi("/alice/pages/commits");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div role="main" aria-label="Commits" class="page-content repository commits">');
    expect(html).toContain('class="active item" href="/alice/pages/commits"');
    expect(html).toContain('<div class="ui top attached header flex-left-right">');
    expect(html).toContain('<table class="ui very basic table unstackable" id="commits-table">');
    expect(html).toContain('<tbody class="commit-list">');

    const rows = html.match(/<tr>/g) ?? [];
    expect(rows).toHaveLength(2 + 1); // 2 commits + the header row
    expect(html).toContain('<td class="author">Test User</td>');
    expect(html).toContain(`class="ui label commit-id-short" rel="nofollow">${pagesTips[1]?.slice(0, 10)}`);
    expect(html).toContain("add app source and docs"); // newest first
    expect(html.indexOf("add app source and docs")).toBeLessThan(html.indexOf("initial commit: add README</a>"));
    expect(html).toContain('<relative-time prefix="" tense="past" datetime="2023-11-14T22:15:20Z"');
    expect(html).not.toContain("pagination menu"); // single page → no Older (§4.11)
  });

  it("paginates at 50 with the Older link driven by LogResult.more (§3.3)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "big", commits: BIG_COMMITS });
    const first = await (await fetchUi("/alice/big/commits")).text();
    expect((first.match(/<tr>/g) ?? []).length - 1).toBe(50); // minus the header row
    expect(first).toContain("commit number 51");
    expect(first).not.toContain("commit number 1</a>");
    expect(first).toContain('<a class="item navigation" href="/alice/big/commits?page=2"');
    expect(first).toContain("Older");

    const second = await (await fetchUi("/alice/big/commits?page=2")).text();
    expect((second.match(/<tr>/g) ?? []).length - 1).toBe(1);
    expect(second).toContain("commit number 1</a>");
    expect(second).not.toContain("Older"); // more === false hides Older (§4.11)

    // §4.11: page < 1 clamps to 1.
    const clamped = await (await fetchUi("/alice/big/commits?page=0")).text();
    expect((clamped.match(/<tr>/g) ?? []).length - 1).toBe(50);
  });

  it("keeps the ?path filter across pages and filters the log (§3.3)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "big", commits: BIG_COMMITS });
    const html = await (await fetchUi("/alice/big/commits?path=counter.txt")).text();
    expect((html.match(/<tr>/g) ?? []).length - 1).toBe(50);
    expect(html).toContain('href="/alice/big/commits?path=counter.txt&amp;page=2"');
  });

  it("renders the ref-suffixed families and 404-shells unresolvable refs (§4.5)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const ok = await (await fetchUi("/alice/pages/commits/branch/main")).text();
    expect(ok).toContain('id="commits-table"');

    for (const path of ["/alice/pages/commits/branch/nope", "/alice/pages/commits/commit/HEAD"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain('<div class="status-page-error">');
    }
  });
});

// --- file view (§5.1: variants + data-global-init + raw link) -------------------

describe("file view page", () => {
  it("renders a source blob with the line table and the §2.4.1 enhancement registry", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const res = await fetchUi("/alice/pages/src/branch/main/app.ts");
    expect(res.status).toBe(200);
    const html = await res.text();

    // §2.4.1 discriminators + registry attributes.
    expect(html).toContain('class="page-content repository file list view file"');
    expect(html).toContain('data-global-init="initRepoFileView"');
    expect(html).toContain('data-raw-file-link="/api/v1/repos/alice/pages/raw/app.ts?ref=main"');
    expect(html).toContain('data-global-click="onCopyContentButtonClick"');

    // Latest-commit box + file header actions.
    expect(html).toContain('id="repo-file-commit-box"');
    expect(html).toContain("add app source and docs");
    expect(html).toContain('<a class="ui mini basic button" href="/api/v1/repos/alice/pages/raw/app.ts?ref=main">Raw</a>');
    expect(html).toContain('<a class="ui mini basic button" href="/alice/pages/commits?path=app.ts">History</a>');

    // The §3.3 code-view variant: line-numbered plain rows.
    expect(html).toContain('<div class="file-view code-view">');
    expect(html).toContain('<td class="lines-num"><span id="L1" data-line-number="1"></span></td>');
    expect(html).toContain('<code class="code-inner">export function main(): void {</code></td>');
    expect(html).toContain('<code class="code-inner">  console.log(&quot;hello cf-gitea&quot;);</code>');

    // Current-dir sidebar (§2.1) + breadcrumb.
    expect(html).toContain('<div id="view-file-tree">');
    expect(html).toContain('class="active" href="/alice/pages/src/branch/main/app.ts"');
    expect(html).toContain('<span class="active section" title="app.ts">app.ts</span>');
    // 3 lines after the trailing-newline drop.
    expect(html).toContain("<div class=\"file-info-entry\">3 lines</div>");
  });

  it("renders a markdown blob through the shared pipeline (markup variant)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const html = await (await fetchUi("/alice/pages/src/branch/main/docs/guide.md")).text();
    expect(html).toContain('<div class="file-view markup markdown"');
    expect(html).toContain('<h1 id="user-content-guide">');
    expect(html).toContain('data-raw-file-link="/api/v1/repos/alice/pages/raw/docs/guide.md?ref=main"');
  });

  it("renders a directory as the shared file table with the parent-link row (§5.1)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const res = await fetchUi("/alice/pages/src/branch/main/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="repo-files-table"');
    expect(html).toContain('<a class="repo-file-line parent-link silenced" href="/alice/pages/src/branch/main">');
    expect(html).toContain('<a class="entry-name" href="/alice/pages/src/branch/main/docs/guide.md" title="guide.md">guide.md</a>');
    expect(html).toContain("add app source and docs"); // the dir's own last commit
    // Directory views are listings, not blob views: no enhancement registry.
    expect(html).not.toContain('data-global-init="initRepoFileView"');
  });

  it("renders a binary file as the media view-raw variant (§4.2)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const html = await (await fetchUi("/alice/pages/src/branch/main/logo.png")).text();
    expect(html).toContain('<div class="view-raw">');
    expect(html).toContain('<img alt="/api/v1/repos/alice/pages/raw/logo.png?ref=main"');
    expect(html).not.toContain("code-view");
  });

  it("resolves tag and commit refs (§3.3 ref suffixes)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    const tagHtml = await (await fetchUi("/alice/pages/src/tag/v1/app.ts")).text();
    expect(tagHtml).toContain('data-raw-file-link="/api/v1/repos/alice/pages/raw/app.ts?ref=v1"');

    const shaHtml = await (await fetchUi(`/alice/pages/src/commit/${pagesTips[0]}/README.md`)).text();
    expect(shaHtml).toContain(`data-raw-file-link="/api/v1/repos/alice/pages/raw/README.md?ref=${pagesTips[0]}"`);
  });

  it("404-shells missing paths, the bare /src family, and prefix-less suffixes (§3.3/§4.5)", async () => {
    await ensureSeededRepo({ owner: "alice", slug: "pages", commits: PAGES_COMMITS });
    for (const path of [
      "/alice/pages/src/branch/main/nope.txt",
      "/alice/pages/src",
      "/alice/pages/src/main", // no branch|tag|commit prefix
      "/alice/pages/src/commit/HEAD", // needs the engine (§3.3 index.ts note)
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain('<div class="status-page-error">');
    }
  });
});
