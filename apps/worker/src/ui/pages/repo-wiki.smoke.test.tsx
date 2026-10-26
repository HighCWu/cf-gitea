/**
 * The wiki family's smoke tests (bench-row 8, PORT-FIRST MODE: ONE happy
 * path per page family — start / view / pages / form / revision — no
 * matrices, the polish wave owns those). Real engine content: the repo
 * seeds through the landed receive flow (testing/seed-repo.ts) and every
 * wiki write lands in the sibling `alice/wikismoke.wiki` cell through the
 * module's OWN write seams (createWikiPageFromForm / editWikiPageFromForm /
 * deleteWikiPageFromForm — the landed service ops behind the form POSTs;
 * no UI route exists yet, the module header's HANDOFF NOTE — so unlike the
 * editor tails there is no router POST to drive; the seams ARE the write
 * path the mount wave wires). Renders are full documents through the
 * module's renderPage.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import {
  createWikiPageFromForm,
  deleteWikiPageFromForm,
  decodeWikiBase64,
  editWikiPageFromForm,
  loadWikiEditData,
  loadWikiPagesData,
  loadWikiRevisionData,
  loadWikiViewData,
  parseWikiPageForm,
  renderWikiEditPage,
  renderWikiNewPage,
  renderWikiPagesPage,
  renderWikiRevisionPage,
  renderWikiStartPage,
  renderWikiViewPage,
  wikiLocale,
} from "./repo-wiki";

// --- fixtures -----------------------------------------------------------------

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme",
    time: 1_700_000_000,
    files: [{ path: "README.md", content: "# wikismoke seed\n" }],
  },
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The doer's git identity — the routes/wiki.ts wikiDoer derivation's shape
 *  (login + noreply email; the mount wave derives it from the session). */
const DOER = { name: "alice", email: "alice@noreply.test.local" };
const ORIGIN = "https://test.local";
const REPO_LINK = "/alice/wikismoke";

let fixtures: { ctx: UiContext; pair: RepositoryWithOwner } | null = null;

async function ensureFixtures(): Promise<NonNullable<typeof fixtures>> {
  if (fixtures !== null) return fixtures;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wikismoke", commits: SEED_COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wikismoke")))
      .get()) ?? null;
  if (repoRow === null) throw new Error("wikismoke repo row missing");
  const owner =
    (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (owner === null) throw new Error("alice row missing");
  fixtures = {
    ctx: {
      viewer: { kind: "user", id: owner.id, username: "alice", isAdmin: false },
      origin: ORIGIN,
      assets: shellAssetsFromManifest(manifest),
      repo: repoRow,
    },
    pair: { repo: repoRow, owner },
  };
  return fixtures;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- 1. the START family (empty wiki; tplWikiStart + the no-wiki arms) --------

describe("smoke: the start family (start.tmpl over an empty wiki)", () => {
  it("renders tplWikiStart for an absent wiki and reports the no-wiki arms", async () => {
    const { ctx, pair } = await ensureFixtures();
    // The view arm's HasWiki decision (wiki.go:471-475).
    const viewData = await loadWikiViewData(env, pair, "", ORIGIN);
    expect(viewData).toEqual({ outcome: "start" });
    // The pages arm's redirect twin (wiki.go:537-540 — 303 /wiki).
    expect(await loadWikiPagesData(env, pair)).toEqual({ outcome: "no-wiki" });

    const html = renderWikiStartPage({ ctx, canWrite: true });
    // The discriminator (start.tmpl:2) + the welcome segment.
    expect(html).toContain('<div role="main" aria-label="Wiki" class="page-content repository wiki start">');
    expect(html).toContain(`<h2>${wikiLocale.welcome}</h2>`);
    expect(html).toContain(`<p>${wikiLocale.welcome_desc}</p>`);
    // The writer-gated Create the First Page button → ?action=_new
    // (start.tmpl:10 — the action-QUERY grammar, not a /wiki/_new route).
    expect(html).toContain(`<a class="ui primary button tw-mr-0" href="${REPO_LINK}/wiki?action=_new">Create the First Page</a>`);
  });
});

// --- 2. the VIEW family (view.tmpl over live service reads) -------------------

describe("smoke: the view family (view.tmpl, content + sidebar + dropdown)", () => {
  it("creates Home + _Sidebar through the write seam and renders the view page", async () => {
    const { ctx, pair } = await ensureFixtures();
    // The create seam (NewWikiPost's write): Home with a wiki-link, then the
    // sidebar — SEQUENTIALLY, each landing is a CAS against the observed tip
    // (concurrent writes on the unborn branch race the ZERO_OID base).
    const home = await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "Home", content: "# Home\n\nSee [[Getting-Started]].\n", message: "" })),
      ORIGIN,
    );
    expect(home.title).toBe("Home");
    const sidebar = await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "_Sidebar", content: "- [Home](Home)\n", message: "" })),
      ORIGIN,
    );
    expect(sidebar.title).toBe("_Sidebar");

    const data = await loadWikiViewData(env, pair, "", ORIGIN);
    if (data.outcome !== "view") throw new Error(`expected view, got ${data.outcome}`);
    expect(data.title).toBe("Home");
    expect(data.pageUrl).toBe("Home");
    // The shared markdown pipeline in wiki mode: the heading carries the
    // upstream-style slug anchor and the [[Getting-Started]] wiki-link
    // rewrites onto {origin}/{owner}/{repo}/wiki/{path}.
    expect(data.contentHtml).toContain('<h1 id="user-content-home">Home</h1>');
    expect(data.contentHtml).toContain(`${ORIGIN}${REPO_LINK}/wiki/Getting-Started`);
    expect(data.sidebarHtml).not.toBe("");

    const html = renderWikiViewPage({ ctx, data, canWrite: true });
    // The discriminator (view.tmpl:2 — bare `repository wiki`) + the
    // with-sidebar class keyed on the sidebar's presence (view.tmpl:71).
    expect(html).toContain('<div role="main" aria-label="Home" class="page-content repository wiki">');
    expect(html).toContain('class="render-content markup wiki-content-main with-sidebar"');
    expect(html).toContain('class="render-content markup wiki-content-sidebar"');
    // The writer button row → the action-QUERY grammar (view.tmpl:51-53).
    expect(html).toContain(`<a class="ui small button" href="${REPO_LINK}/wiki/Home?action=_edit">Edit</a>`);
    expect(html).toContain(`<a class="ui small primary button" href="${REPO_LINK}/wiki?action=_new">New Page</a>`);
    expect(html).toContain(`data-url="${REPO_LINK}/wiki/Home?action=_delete"`);
    // The delete modal (view.tmpl:99-103) + the history link with the count.
    expect(html).toContain('id="repo-wiki-delete-page-modal"');
    expect(html).toContain(`<a class="ui basic button tw-px-3 tw-gap-3" title="Page Revision" href="${REPO_LINK}/wiki/Home?action=_revision">`);
    // The dropdown lists the pages minus _Sidebar (wiki.go:208-210).
    expect(html).toContain(`href="${REPO_LINK}/wiki/?action=_pages"`);
  });
});

// --- 3. the PAGES family (pages.tmpl; natural sort, git-entry, delete) --------

describe("smoke: the pages family (pages.tmpl over the tree walk)", () => {
  it("lists pages naturally sorted with git-entry links, and deletes one", async () => {
    const { ctx, pair } = await ensureFixtures();
    await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "Zebra pages", content: "z\n", message: "" })),
      ORIGIN,
    );
    await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "Aardvark Notes", content: "a\n", message: "" })),
      ORIGIN,
    );

    const data = await loadWikiPagesData(env, pair);
    if (data.outcome !== "pages") throw new Error(`expected pages, got ${data.outcome}`);
    // Natural sort (wiki.go:563) — digit/case-safe here. NOTE: the pages
    // TABLE keeps _Sidebar/_Footer (only the view dropdown filters them,
    // wiki.go:208-210), so the listing is the full tree.
    expect(data.pages.map((page) => page.name)).toEqual(["_Sidebar", "Aardvark Notes", "Home", "Zebra pages"]);

    const html = renderWikiPagesPage({ ctx, data, canWrite: true });
    // The discriminator (pages.tmpl:2).
    expect(html).toContain('<div role="main" aria-label="Pages" class="page-content repository wiki pages">');
    // The rows: name link + the git-entry chevron over the PathEscaped raw
    // entry name (pages.tmpl:20-21) + the Last updated cells.
    expect(html).toContain(`<a href="${REPO_LINK}/wiki/Home">Home</a>`);
    expect(html).toContain(`href="${REPO_LINK}/wiki/Home.md"`);
    expect(html).toContain(`data-tooltip-content="${wikiLocale.original_git_entry_tooltip}"`);
    expect(html).toContain("Last updated");
    expect(html).toContain(`<a class="ui small primary button" href="${REPO_LINK}/wiki?action=_new">New Page</a>`);

    // The delete seam (DeleteWikiPagePost's write — "" would mean Home):
    // the page vanishes from the next listing.
    await deleteWikiPageFromForm(env, pair, DOER, "Zebra-pages");
    const after = await loadWikiPagesData(env, pair);
    if (after.outcome !== "pages") throw new Error(`expected pages, got ${after.outcome}`);
    expect(after.pages.map((page) => page.name)).toEqual(["_Sidebar", "Aardvark Notes", "Home"]);
  });
});

// --- 4. the FORM family (new.tmpl — BOTH the _new and _edit arms) -------------

describe("smoke: the form family (new.tmpl's two arms)", () => {
  it("renders the edit arm over the page's content and the new arm prefilled", async () => {
    const { ctx, pair } = await ensureFixtures();
    // The EDIT arm (EditWiki → tplWikiNew with PageIsWikiEdit).
    const data = await loadWikiEditData(env, pair, "Home", ORIGIN);
    if (data.outcome !== "edit") throw new Error(`expected edit, got ${data.outcome}`);
    expect(data.content).toBe("# Home\n\nSee [[Getting-Started]].\n");
    const edit = renderWikiEditPage({ ctx, data, error: null });
    // Upstream's literal relative action (new.tmpl:12 — posts to the
    // current URL; _edit lands in WikiPost's DEFAULT arm).
    expect(edit).toContain('<form class="ui form form-fetch-action" action="?action=_edit" method="post">');
    expect(edit).toContain('<input name="title" value="Home"');
    expect(edit).toContain('id="edit_area" name="content"');
    expect(edit).toContain("# Home");
    expect(edit).toContain('<a class="ui tiny primary button" href="/alice/wikismoke/wiki?action=_new">New Page</a>');
    expect(edit).toContain('<button type="submit" class="ui primary button">Save Page</button>');

    // The NEW arm: the welcome text as the content prefill (new.tmpl:20-23),
    // no tiny New Page button, ?action=_new action.
    const fresh = renderWikiNewPage({ ctx, initialTitle: "", error: null });
    expect(fresh).toContain('<form class="ui form form-fetch-action" action="?action=_new" method="post">');
    expect(fresh).toContain(wikiLocale.welcome);
    expect(fresh).not.toContain('class="ui tiny primary button"');
    // The error slot (new.tmpl:5's base/alert reduction).
    const failed = renderWikiNewPage({ ctx, initialTitle: "_pages", error: 'wiki title is reserved: _pages' });
    expect(failed).toContain('<div class="ui negative message">wiki title is reserved: _pages</div>');
  });
});

// --- 5. the REVISION family (revision.tmpl over the paged log) ----------------

describe("smoke: the revision family (revision.tmpl over listWikiPageRevisions)", () => {
  it("edits Home again and renders both revisions with the commit list", async () => {
    const { ctx, pair } = await ensureFixtures();
    // The edit seam (EditWikiPost's write) — the second commit on Home.md.
    const edited = await editWikiPageFromForm(
      env,
      pair,
      DOER,
      "Home",
      parseWikiPageForm(new URLSearchParams({ title: "", content: "# Home v2\n", message: "" })),
      ORIGIN,
    );
    expect(edited.title).toBe("Home"); // the empty title keeps the old name

    const data = await loadWikiRevisionData(env, pair, "", null);
    if (data.outcome !== "revision") throw new Error(`expected revision, got ${data.outcome}`);
    expect(data.pageUrl).toBe("Home");
    expect(data.count).toBe(2);
    expect(data.commits).toHaveLength(2);

    const html = renderWikiRevisionPage({ ctx, data });
    // The discriminator (revision.tmpl:2).
    expect(html).toContain('<div role="main" aria-label="Home" class="page-content repository wiki revisions">');
    // The count header + the back-to-wiki button (revision.tmpl:8, 26).
    expect(html).toContain(`<a class="ui basic button tw-px-3" title="Back to wiki page" href="${REPO_LINK}/wiki/Home">`);
    expect(html).toContain("<div class=\"sixteen wide column\">2 Commits</div>");
    // The CommitList rows: both commit messages (create + edit), the
    // engine-display projection (wikiCommitAsEngineCommit).
    expect(html).toContain("Add &quot;Home&quot;"); // the service's Go-%q default message
    expect(html).toContain("Update &quot;Home&quot;");
    // Single page → no pagination links (the Newer/Older reduction).
    expect(html).not.toContain('class="item navigation"');
    // Sanity: the decoded base64 round trip the loaders rely on.
    expect(decodeWikiBase64("")).toBe("");
  });
});
