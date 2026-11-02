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
 * module's renderPage. The later families (6 webhook emissions, 7 the
 * commit-diff twin, 8 the view loader's raw-file round + the
 * _Sidebar/_Footer suppression) keep the same happy-path discipline.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { serializeCommit, serializeTree, type ApiObject, type Person } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { branchRef, commitApiChangeError } from "../../api/services/engine";
import { buildBlobObject } from "../../api/services/git-models";
import { repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { wikiBranch, wikiCell } from "../../services/wiki";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { shortSha } from "../page-data";
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
  wikiTipOf,
} from "./repo-wiki";
import { loadWikiCommitDiffPatch, parseWikiCommitDownloadTail, parseWikiCommitViewTail } from "./wiki-commit-diff";

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
    // The 48px book glyph (start.tmpl:6 — octicon-book, allowlisted with
    // the wiki nav wave).
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="48" height="48" class="svg octicon-book"');
    // The header tab strip carries the Wiki tab, ACTIVE on the family's
    // own pages (shell RepoTab — upstream header.tmpl:162-166: the g w
    // shortcut + octicon-book; activeTab="wiki" = .PageIsWiki).
    expect(html).toContain('<a class="active item" href="/alice/wikismoke/wiki" data-shortcut-keys="g w">');
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
    // The page-name arm (the commit-diff twin carries kind "commit-diff").
    if (data.outcome !== "view" || data.kind === "commit-diff") throw new Error(`expected page view, got ${data.outcome}`);
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
  it("edits Home again and renders both revisions with the WIKI-arm commit list", async () => {
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
    // The WIKI arm (commits_list.tmpl:23-34's PageIsWiki discriminator):
    // the sha cells link the /wiki/commit base (the landed wiki commit-diff
    // page — never the dead repo view) and the subject renders as the PLAIN
    // commit-summary span (no anchor, commits_list.tmpl:33-36).
    expect(html).toContain(`href="${REPO_LINK}/wiki/commit/`);
    expect(html).not.toContain(`href="${REPO_LINK}/commit/`);
    const attrEscape = (text: string): string =>
      text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    for (const commit of data.commits) {
      expect(html).toContain(`<span class="commit-summary" title="${attrEscape(commit.message.split("\n")[0] ?? "")}">`);
    }
    // Single page → no pagination links (the Newer/Older reduction).
    expect(html).not.toContain('class="item navigation"');
    // Sanity: the decoded base64 round trip the loaders rely on.
    expect(decodeWikiBase64("")).toBe("");
  });
});

// --- 6. the WEBHOOK family (the UI writer's path — the same services/wiki.ts
//        seam the /api/v1 routes ride, so both surfaces emit identically;
//        the API suite owns the shape assertions, this owns the parity proof)

describe("smoke: the webhook emissions family (the UI writer's path)", () => {
  it("create/edit/delete through the FromForm seams deliver the same wiki triple", async () => {
    const { pair } = await ensureFixtures();
    const hookRows = await drizzle(env.DB)
      .insert(webhooks)
      .values({
        repoId: pair.repo.id,
        url: "https://hooks.invalid/wiki-smoke",
        events: JSON.stringify({ choose_events: true, branch_filter: "*", events: { wiki: true } }),
        isActive: true,
        type: "gitea",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: webhooks.id })
      .all();
    const hook = hookRows[0];
    if (hook === undefined) throw new Error("hook seed failed");

    const created = await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "Hook Page", content: "# hook\n", message: "" })),
      ORIGIN,
    );
    expect(created.title).toBe("Hook Page");
    const edited = await editWikiPageFromForm(
      env,
      pair,
      DOER,
      "Hook-Page",
      parseWikiPageForm(new URLSearchParams({ title: "Hook Page Renamed", content: "# renamed\n", message: "ui msg" })),
      ORIGIN,
    );
    expect(edited.title).toBe("Hook Page Renamed");
    await deleteWikiPageFromForm(env, pair, DOER, "Hook-Page-Renamed");

    const deliveries = await drizzle(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.hookId, hook.id))
      .orderBy(asc(webhookDeliveries.id))
      .all();
    expect(deliveries).toHaveLength(3);
    for (const delivery of deliveries) {
      expect(delivery.eventType).toBe("wiki");
      expect(delivery.eventGroup).toBe("wiki");
      expect(delivery.repoId).toBe(pair.repo.id);
      // No `state` assertion: the service seam enqueues through the real
      // WEBHOOK_DELIVERY binding and index.ts's queue consumer is live in
      // the vitest workerd (webhooks-push.test.ts's settleDeliveries note)
      // — the row may already have left `pending` by assert time. State
      // semantics belong to the consumer's suite; this asserts the emission.
    }
    const payloads = deliveries.map((delivery) => JSON.parse(delivery.payloadContent) as Record<string, unknown>);
    // The triple fires exactly once per write, in order, with the same
    // upstream WikiPayload field set the API suite pins.
    expect(payloads.map((payload) => payload.action)).toEqual(["created", "edited", "deleted"]);
    for (const payload of payloads) {
      expect(Object.keys(payload).sort()).toEqual(["action", "comment", "page", "repository", "sender"]);
      expect((payload.sender as Record<string, unknown>).login).toBe("alice");
      expect((payload.repository as Record<string, unknown>).full_name).toBe("alice/wikismoke");
    }
    expect(payloads[0]?.page).toBe("Hook-Page");
    expect(payloads[0]?.comment).toBe('Add "Hook Page"'); // the router-defaulted template
    expect(payloads[1]?.page).toBe("Hook-Page-Renamed");
    expect(payloads[1]?.comment).toBe("ui msg");
    expect(payloads[2]?.page).toBe("Hook-Page-Renamed");
    expect(payloads[2]?.comment).toBe(""); // the Go-zero field (delete takes no comment upstream)
  });
});

// --- 7. the COMMIT-DIFF family (web.go:1619-1620 — the PageIsWiki commit
//        page + the .diff/.patch downloads, both over the SIBLING wiki cell
//        through pages/wiki-commit-diff.tsx; the view rides the view loader,
//        the downloads serve raw through index.ts's wikiPage serving branch
//        — the route-level byte pins live in ui/index.test.ts)

describe("smoke: the commit-diff family (web.go:1619-1620 over the wiki cell)", () => {
  it("serves the revision-diff view through the view loader and renders the PageIsWiki commit page", async () => {
    const { ctx, pair } = await ensureFixtures();
    // A SLASHED + SPACED title: the codec stores the flat QueryEscaped git
    // entry (`Docs%2FDiff-Guide.md`) — the raw downloads' blob read-back
    // exercises the wikiEnginePath encode below.
    const created = await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "Docs/Diff Guide", content: "# diff guide\n\nkept line\n", message: "create the diff guide" })),
      ORIGIN,
    );
    expect(created.title).toBe("Docs/Diff Guide"); // the DISPLAY title (toWikiPageMetaData)
    expect(created.sub_url).toBe("Docs%2FDiff-Guide"); // the coded WebPath — the flat stored entry's escape
    const tip = await wikiTipOf(env, pair);
    if (tip === undefined) throw new Error("wiki tip missing");
    const sha = tip.target;

    // The view arm: the commit tail parses OUT of the page-name path
    // (upstream chi specificity — web.go:1619's pattern beats `/*`).
    const data = await loadWikiViewData(env, pair, `commit/${sha}`, ORIGIN);
    if (data.outcome !== "view" || data.kind !== "commit-diff") throw new Error(`expected commit-diff view, got ${data.outcome}`);
    expect(data.view.commit.oid).toBe(sha);
    expect(data.view.commit.subject).toBe("create the diff guide");
    expect(data.title).toBe(`create the diff guide · ${shortSha(sha)}`);
    expect(data.view.files.map((file) => file.file.path)).toEqual(["Docs%2FDiff-Guide.md"]); // the flat stored entry

    const html = renderWikiViewPage({ ctx, data, canWrite: true });
    // The commit-page discriminator (commit_page.tmpl:5) + the WIKI active
    // tab (the group's PageIsWiki data).
    expect(html).toContain('<div role="main" aria-label="create the diff guide · ' + shortSha(sha) + '" class="page-content repository diff">');
    expect(html).toContain('<a class="active item" href="/alice/wikismoke/wiki" data-shortcut-keys="g w">');
    // The sha labels ride the WIKI commit base (commit_page.tmpl:2's Iif).
    expect(html).toContain(`href="${REPO_LINK}/wiki/commit/${sha}"`);
    // The header-button block is PageIsWiki-gated OFF (commit_page.tmpl:12).
    expect(html).not.toContain("Browse Source");
    // The identity sentence (committer is author — the DOER wrote it).
    expect(html).toContain("committed");
    // The diff box for the wiki page entry (box.tmpl's DOM, one file).
    expect(html).toContain('data-new-filename="Docs%2FDiff-Guide.md"');
    expect(html).toContain('data-line-type="add"');
    expect(html).toContain("<code class=\"code-inner\"># diff guide</code>");
  });

  it("renders the raw downloads as git-apply-valid bytes over the wiki cell", async () => {
    const { pair } = await ensureFixtures();
    const tip = await wikiTipOf(env, pair);
    if (tip === undefined) throw new Error("wiki tip missing");
    const sha = tip.target;

    // `.diff` — the plain unified diff (GetRawDiff's RawDiffNormal arm over
    // the wiki repo): the stored flat entry name in the headers, the
    // new-file shape, a count-consistent hunk (the renderer's git-apply
    // validity — the byte-exact markers contract is the renderer suite's).
    const diffBody = await loadWikiCommitDiffPatch(env, pair, sha, "diff");
    if (diffBody === null) throw new Error("expected the .diff body over the wiki commit");
    const diff = diffBody;
    expect(diff.startsWith("diff --git a/Docs%2FDiff-Guide.md b/Docs%2FDiff-Guide.md\n")).toBe(true);
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/Docs%2FDiff-Guide.md");
    expect(diff).toMatch(/^@@ -0,0 \+1,3 @@$/m);
    expect(diff).toContain("+# diff guide");
    expect(diff).toContain("+kept line"); // the byte-exact trailing-newline contract is the renderer suite's

    // `.patch` — the git-am mail WITHOUT the signature tail (the commit
    // arm's --no-signature parity, diff.go:73).
    const patchBody = await loadWikiCommitDiffPatch(env, pair, sha, "patch");
    if (patchBody === null) throw new Error("expected the .patch body over the wiki commit");
    const patch = patchBody;
    expect(patch.startsWith(`From ${sha} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(patch).toContain("From: alice <alice@noreply.test.local>");
    expect(patch).toContain("Subject: [PATCH] create the diff guide");
    expect(patch).toContain("\n---\n");
    expect(patch).toContain("diff --git a/Docs%2FDiff-Guide.md");
    expect(patch.includes("\n-- \n")).toBe(false); // no `-- \n<version>` tail
  });

  it("folds the grammar misses upstream's way (unknown sha, pattern misses, the dotted tail's page-name fold)", async () => {
    const { pair } = await ensureFixtures();
    const tip = await wikiTipOf(env, pair);
    if (tip === undefined) throw new Error("wiki tip missing");
    const sha = tip.target;

    // Grammar unit pins: the two patterns and their misses.
    expect(parseWikiCommitViewTail(`commit/${sha}`)).toEqual({ sha });
    expect(parseWikiCommitDownloadTail(`commit/${sha}.patch`)).toEqual({ sha, ext: "patch" });
    expect(parseWikiCommitViewTail(`commit/${sha}/extra`)).toBeNull(); // one-segment pattern
    expect(parseWikiCommitDownloadTail("commit/zzz.diff")).toBeNull(); // non-hex sha

    // A well-shaped UNKNOWN sha: the download loader nulls (the serving
    // arm's §4.5 shell — the diffpatch family's convention); the view arm
    // interim-folds to the family's missing outcome (upstream Diff 404s —
    // the loader cannot answer a 404 through the fixed outcome set, the
    // module doc carries the disclosure).
    const ghost = "a".repeat(40);
    expect(await loadWikiCommitDiffPatch(env, pair, ghost, "diff")).toBeNull();
    expect(await loadWikiCommitDiffPatch(env, pair, ghost, "patch")).toBeNull();
    expect(await loadWikiViewData(env, pair, `commit/${ghost}`, ORIGIN)).toEqual({ outcome: "missing" });

    // Uppercase hex is a PATTERN miss (web.go's lowercase-only class) — the
    // tail stays a page name, upstream's combo fold.
    expect(await loadWikiViewData(env, pair, `commit/${sha.toUpperCase()}`, ORIGIN)).toEqual({ outcome: "missing" });
    // Plain grammar misses keep the page-name path (a page literally named
    // "commit/zzz" would be shadowed only for the HEX shapes).
    expect(await loadWikiViewData(env, pair, "commit/zzz", ORIGIN)).toEqual({ outcome: "missing" });
    // The dotted download tail is NOT the view arm — upstream serves the
    // bytes at web.go:1620 through index.ts's serving branch, which
    // dispatches BEFORE the view loader (ui/index.test.ts pins the raw
    // bytes at the route). The VIEW loader's own page-name fold below stays
    // the grammar's documented miss shape for a tail it never claims.
    expect(await loadWikiViewData(env, pair, `commit/${sha}.diff`, ORIGIN)).toEqual({ outcome: "missing" });
  });
});

// --- 8. the view loader's render decisions (the wiki.go VIEW-handler arms:
//        the raw-file round wiki.go:156-164/240-242 + the _Sidebar/_Footer
//        suppression wiki.go:232-233/285/297 — appended LAST: the raw-file
//        seed moves the wiki ref, append-only like the matrix's commit-diff
//        world; nothing after this describe reads the tip)

describe("smoke: the view loader's raw-file round and the sidebar/footer suppression", () => {
  it("carries the isRaw redirect decision for a stored non-.md entry and skips the own sidebar/footer box", async () => {
    const { ctx, pair } = await ensureFixtures();
    // The _Footer page (the sidebar exists from the view family) — the
    // suppression pins need the OTHER box to assert a LOADED counterpart.
    const footer = await createWikiPageFromForm(
      env,
      pair,
      DOER,
      parseWikiPageForm(new URLSearchParams({ title: "_Footer", content: "- footer line\n", message: "" })),
      ORIGIN,
    );
    expect(footer.title).toBe("_Footer");

    // Viewing _Sidebar: the OWN box suppresses (wiki.go:285's !isSideBar
    // guard) while the footer still loads (wiki.go:297).
    const sideData = await loadWikiViewData(env, pair, "_Sidebar", ORIGIN);
    if (sideData.outcome !== "view" || sideData.kind === "commit-diff") throw new Error(`expected page view, got ${sideData.outcome}`);
    expect(sideData.sidebarHtml).toBe("");
    expect(sideData.footerHtml).not.toBe("");
    const sideHtml = renderWikiViewPage({ ctx, data: sideData, canWrite: true });
    expect(sideHtml).not.toContain("wiki-content-sidebar");
    expect(sideHtml).not.toContain("with-sidebar");
    expect(sideHtml).toContain("wiki-content-footer");

    // Viewing _Footer: the mirror arm (wiki.go:297's guard drops the own
    // box, the sidebar loads).
    const footData = await loadWikiViewData(env, pair, "_Footer", ORIGIN);
    if (footData.outcome !== "view" || footData.kind === "commit-diff") throw new Error(`expected page view, got ${footData.outcome}`);
    expect(footData.footerHtml).toBe("");
    expect(footData.sidebarHtml).not.toBe("");

    // A plain missing page stays the bare noEntry fold — no redirect field.
    expect(await loadWikiViewData(env, pair, "Never-Was", ORIGIN)).toEqual({ outcome: "missing" });

    // The raw-file round (wiki.go:156-164): a stored NON-.md entry — a
    // git-pushed image, the page writer's codec cannot produce one — seeded
    // through the same cell primitives applyWikiChanges uses.
    const tip = await wikiTipOf(env, pair);
    if (tip === undefined) throw new Error("wiki tip missing for the raw-file seed");
    const blob = await buildBlobObject(new TextEncoder().encode("not-really-a-png\n"));
    const tree = serializeTree([{ name: "logo.png", mode: "100644", oid: blob.oid }]);
    const person: Person = { name: DOER.name, email: DOER.email, time: 1_700_000_200, tz: "+0000" };
    const commit = serializeCommit({
      tree: tree.oid,
      parents: [tip.target],
      author: person,
      committer: person,
      message: "seed: the raw-file fixture",
    });
    const objects: ApiObject[] = [
      blob,
      { oid: tree.oid, type: tree.type, data: tree.data },
      { oid: commit.oid, type: commit.type, data: commit.data },
    ];
    const cell = wikiCell(env, pair);
    const stored = await cell.putApiObjects(objects);
    if (stored.tag !== "ok") throw new Error(`raw-file seed objects refused: ${stored.tag}`);
    const landed = await cell.commitApiChange({
      ref: branchRef(wikiBranch(pair)),
      expectedOldOid: tip.target,
      newOid: commit.oid,
    });
    if (landed.tag !== "committed") throw commitApiChangeError(landed);

    // The view of the raw name: the .md probes miss, the trimmed round hits
    // — the loader carries the isRaw redirect target (wiki.go:240-242) on
    // the missing outcome; the serving arm's 303 mapping is the disclosed
    // interim (the matrix pins the interim fold at the route).
    expect(await loadWikiViewData(env, pair, "logo.png", ORIGIN)).toEqual({
      outcome: "missing",
      rawRedirectTo: "logo.png",
    });
  });
});
