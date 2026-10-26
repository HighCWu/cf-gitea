/**
 * The WIKI family's DEFERRED route-level matrix (pages/repo-wiki.tsx —
 * `GET+POST /{owner}/{repo}/wiki[/*]` mounted at window-2e C2a, commit
 * 9516bf1, the `?action=` form-value dispatch over web.go:1611-1626's two
 * combos).
 *
 * ## THE ESCALATED BUG — FIXED AT a58cad5 (was: DISCLOSED RED, 2026-10-26)
 *
 * This matrix caught the mounted wiki family UNREACHABLE: `parseUiRoute`'s
 * EARLY wave-46 `head === "wiki"` arm (the wiki-blob-excerpt twin, commit
 * 67adfb7) hard-returned `null` for every non-blob_excerpt wiki shape, and
 * window-2e's wiki-family arm (commit 9516bf1) sat after it — dead code.
 * The suite shipped DISCLOSED RED (23 failing on that single root cause)
 * and the fix landed at a58cad5 in TWO layers, exactly the split the
 * runtime proof exposed:
 *
 *   1. PARSE SHADOW: the early excerpt arm now claims ONLY its exact
 *      5-segment shape (`wiki/blob_excerpt/{sha}`); every other wiki tail
 *      falls through to the wiki-family arm (`family: "wiki"`, rawTail).
 *   2. REGISTRATION ORDER: the `/:owner/:repo/wiki/*` wildcard had
 *      registered BEFORE `/:owner/:repo/wiki/blob_excerpt/:sha`, so even
 *      unshadowed the excerpt fetches died on the page handler's drift
 *      guard — reordered specific-before-wildcard.
 *
 * The claim pins below keep guarding both layers (the family shapes, the
 * excerpt twin's exact 5-segment claim, and a live 200 through the mounted
 * route); the full matrix runs green over the real production path.
 *
 * The matrix body (per-arm notes as originally written):
 *
 * The committed smoke (repo-wiki.smoke.test.tsx) owns one happy
 * path per page through the LOADERS + renderers directly — it never drives
 * the mounted router, so every gate/redirect/failure arm the prologue and
 * wikiSubmit own was unpinned. THIS file adds those route-level arms on the
 * org-repos 3c596f9 minted-session pattern (`uiRouter.fetch` on the real
 * production path, the execution context awaited) over a disjoint `w107`
 * fixture world created through the LANDED services. No git-http pushes:
 * the `*.wiki` gate URLs are §4.4-404 so the receive flow cannot seed a
 * wiki cell — fixtures write through the module's own seams (the service
 * ops behind the route POSTs), and the pager world lands straight into the
 * cell via the same primitives `applyWikiChanges` uses (one batched
 * putApiObjects + one ZERO_OID commitApiChange; the parent chain carries
 * all revisions):
 *
 *   - the hasWiki gate (MustEnableWiki, web.go:1614): a settings-disabled
 *     wiki 404-shells EVERY arm — the view, the ?action=_pages/_revision/
 *     _new/_edit GETs and the POSTs — indistinguishable from a missing
 *     repo, and the refused POST leaves the wiki cell unborn;
 *   - anonymous reads of a public wiki: the view (writer chrome absent),
 *     _pages and _revision; the writer-gated _new/_edit GETs and all
 *     POSTs 404-shell for the anonymous viewer and the signed-in
 *     non-writer alike (the prologue's canWrite pair — grant && !archived);
 *   - the archived arm: reads stay open (the start page over the unborn
 *     cell) while the owner's _new/_edit GETs and POSTs 404-shell
 *     (RepoMustNotBeArchived) and write nothing;
 *   - the create round-trip: POST ?action=_new 303s onto `/wiki/{sub_url}`
 *     (NewWikiPost's JSONRedirect target) and the fresh page renders for
 *     an anonymous reader;
 *   - the edit round-trip + rename semantics: an empty title keeps the
 *     name (303 onto the same page; message "" → the default
 *     `Update %q(WebPath)` subject), a new title 303s onto the renamed
 *     page, the old name folds to the missing-303, and the revision list
 *     follows the MATCHED git path only (the renamed page's log starts at
 *     the rename commit — no --follow);
 *   - the delete round-trip: ?action=_delete 303s onto
 *     `/wiki/?action=_pages` (DeleteWikiPagePost's target), the page goes
 *     missing, and the BARE-tail delete (rawTail "") deletes Home
 *     (wiki.go:730-731);
 *   - the missing-page 303s (wiki.go:238/340/400): the view, _revision
 *     and the writer's _edit all 303 onto `/wiki/?action=_pages`; the
 *     anonymous _edit 404s first (the gate precedes the load); a ghost
 *     delete folds through the ApiError(404) re-render arm onto the same
 *     303; the claimed-but-unimplemented raw tail reads as a page name and
 *     misses the same way;
 *   - the service's exact validation texts re-rendering the form with the
 *     carried title: the reserved-name refusal (`wiki title is reserved:
 *     _pages`) and the duplicate refusal (`wiki page already exists
 *     [title: Home.md]` — the CODED git path), both 200 with the
 *     submitted title kept in the input;
 *   - the §2.8 same-origin guard: a cross-origin POST 403s with the plain
 *     text before anything runs;
 *   - the no-wiki arms over a settings-enabled, branch-less repo: the view
 *     and _revision render tplWikiStart (wiki.go:471-475/507-511 parity).
 *     TWO mounted-arm divergences are PINNED AS-IS here and disclosed to
 *     the orchestrator (benign render-instead-of-redirect choices, NOT
 *     asserted as upstream parity): _pages and _edit render the start page
 *     at 200 where UPSTREAM redirects to /wiki (WikiPages wiki.go:537-540,
 *     EditWiki wiki.go:692-695), and the _new form carries the mount's
 *     constant empty title where upstream prefills "Home" on a branch-less
 *     wiki (wiki.go:655-663);
 *   - the ?page= revision pager at CommitsRangeSize=50 over a 55-revision
 *     page: the view's history button counts 55, page 1 shows 50 rows with
 *     the Older link (&amp;page=2), page 2 shows 5 with the Newer fold onto
 *     the bare ?action=_revision href (the page<=1 arm), a beyond-end page
 *     renders zero rows with only its Newer link, and the junk ?page=
 *     folds to page 1 (parsePageNumber's clamp).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { serializeCommit, serializeTree, type ApiObject, type Person } from "@cf-gitea/git-engine";

import { branchRef, commitApiChangeError, ZERO_OID } from "../../api/services/engine";
import { buildBlobObject } from "../../api/services/git-models";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { wikiBranch, wikiCell } from "../../services/wiki";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { createWikiPageFromForm, parseWikiPageForm, wikiTipOf } from "./repo-wiki";

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — fixed, deterministic stamps
const ORIGIN = "https://test.local";
const OWNER = "w107gal"; // the repo owner — the only writer
const STRANGER = "w107pal"; // a signed-in non-writer over the public repo

/** The route's derived commit identity (the seeded user has no stored email
 *  → wikiPrologue's noreply form) — the fixture writes use the SAME identity
 *  so subjects are stable across the two write paths. */
const DOER = { name: OWNER, email: `${OWNER}@noreply.test.local` };

const REPO_LINK = `/${OWNER}/w107wik`;
/** The missing-page fold's target (wikiPagesAction's exact string). */
const PAGES_ACTION = `${REPO_LINK}/wiki/?action=_pages`;

/** The pager world's revision count: one family over the 50-per-page
 *  CommitsRangeSize (WIKI_REVISIONS_PAGE_SIZE) — a 50 + 5 split. */
const PAGER_REVISIONS = 55;

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

/** The real production path: parse → resolveUiRequest (the wiki prologue's
 *  repo read + hasWiki gate) → load → render, on the mounted uiRouter with
 *  the synthetic manifest; the execution context is awaited. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie for the fixture user (the value is never
 *  asserted — minted per call like the sibling matrices' helpers). */
async function cookieFor(username: string): Promise<string> {
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (user === undefined) throw new Error(`w107 fixture user missing: ${username}`);
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}`;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  return fetchUi(path, as === undefined ? undefined : { headers: { cookie: await cookieFor(as) } });
}

/** A same-origin form POST (the default arm of wikiSubmit's guard), with an
 *  origin-header override for the cross-origin arm. */
async function postForm(path: string, body: Record<string, string>, as?: string, originHeader: string = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: originHeader,
  };
  if (as !== undefined) headers.cookie = await cookieFor(as);
  return fetchUi(path, { method: "POST", headers, body: new URLSearchParams(Object.entries(body)).toString() });
}

/** The D1 pair for one fixture repo (the loaders' RepositoryWithOwner). */
async function pairFor(slug: string): Promise<RepositoryWithOwner> {
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
      .get()) ?? null;
  if (repoRow === null) throw new Error(`w107 fixture repo missing: ${slug}`);
  const owner = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, OWNER)).get()) ?? null;
  if (owner === null) throw new Error("w107 fixture owner missing");
  return { repo: repoRow, owner };
}

/** The pager world: PAGER_REVISIONS chained commits on `Pager.md`, landed as
 *  ONE batched putApiObjects + one ZERO_OID CAS (the unborn-cell arm of
 *  applyWikiChanges, unbatched — the parent chain makes every revision
 *  reachable from the single landed ref tip). */
async function seedWikiHistory(pair: RepositoryWithOwner): Promise<void> {
  const cell = wikiCell(env, pair);
  const ref = branchRef(wikiBranch(pair));
  const encoder = new TextEncoder();
  const objects: ApiObject[] = [];
  let parent: string | null = null;
  let tipOid = "";
  for (let index = 1; index <= PAGER_REVISIONS; index += 1) {
    const blob = await buildBlobObject(encoder.encode(`# rev ${index}\n`));
    objects.push(blob);
    const tree = serializeTree([{ name: "Pager.md", mode: "100644", oid: blob.oid }]);
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    const person: Person = { name: DOER.name, email: DOER.email, time: T0 + index * 60, tz: "+0000" };
    const commit = serializeCommit({
      tree: tree.oid,
      parents: parent === null ? [] : [parent],
      author: person,
      committer: person,
      message: `pager rev ${index}`,
    });
    objects.push({ oid: commit.oid, type: commit.type, data: commit.data });
    parent = commit.oid;
    tipOid = commit.oid;
  }
  const stored = await cell.putApiObjects(objects);
  if (stored.tag !== "ok") throw new Error(`pager seed objects refused: ${stored.tag}`);
  const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: tipOid });
  if (landed.tag !== "committed") throw commitApiChangeError(landed);
}

async function ensureRepo(service: RepoService, owner: { id: number; username: string }, slug: string): Promise<void> {
  const existing = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, owner.username.toLowerCase()), eq(repositories.slug, slug)))
    .get();
  if (existing === undefined) {
    await service.create({
      owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
      name: slug,
      isPrivate: false,
      status: "ready",
    });
  }
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get()) === undefined) {
    await seedVerifiedUser({ username: OWNER });
  }
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, STRANGER)).get()) === undefined) {
    await seedVerifiedUser({ username: STRANGER });
  }
  const ownerRow = (await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.usernameLower, OWNER)).get())!;
  const service = new RepoService(env.DB);
  for (const slug of ["w107wik", "w107bare", "w107nowiki", "w107arch", "w107pager"]) {
    await ensureRepo(service, ownerRow, slug);
  }
  // The settings-disabled wiki (the MustEnableWiki shells) and the archived
  // repo (the RepoMustNotBeArchived half of the write grant).
  await saveRepoSettings(env.DB, (await pairFor("w107nowiki")).repo.id, { hasWiki: false }, new Date(T0 * 1000));
  await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, (await pairFor("w107arch")).repo.id)).run();
  // The fixture wiki state on w107wik: Home through the SAME service seam the
  // route POSTs call (message "" → the default `Add "Home"` subject) — the
  // subject of the anonymous view/revision arms and the duplicate carrier.
  await createWikiPageFromForm(
    env,
    await pairFor("w107wik"),
    DOER,
    parseWikiPageForm(new URLSearchParams({ title: "Home", content: "# Home base\n", message: "" })),
    ORIGIN,
  );
  // The pager world: 55 chained revisions on one page, one batched landing.
  await seedWikiHistory(await pairFor("w107pager"));
});

// --- the parser claim (the escalated bug's pin — fixed at a58cad5) -------------------
//
// REAL BUG #11 of the polish program, caught by this matrix's first run and
// now FIXED (a58cad5, two layers):
// `parseUiRoute` carried TWO `head === "wiki"` arms. The EARLIER one was
// wave-46's wiki-blob-excerpt twin (commit 67adfb7):
//
//   if (head === "wiki") {
//     if (rest.length !== 2 || rest[0] !== "blob_excerpt") return null;
//     return { family: "wiki-blob-excerpt", ... };
//   }
//
// It answered `null` for EVERY other wiki shape — including the bare and
// single-tail forms — and the window-2e wiki-family arm (commit 9516bf1:
// `return { family: "wiki", owner, repo, rawTail }`) sat AFTER it, so it
// was unreachable dead code. The mounted wiki family
// (GET+POST /{owner}/{repo}/wiki[/*]) therefore never parsed: the
// dispatcher's handlesUiRoute was false (production fell to the engine's
// 404) and a direct uiRouter fetch died on the prologue's drift guard
// (Hono's plain "404 Not Found"). The smoke never saw this — it drives the
// loaders/renders directly, not the router. LAYER 2 (the same runtime proof
// exposed it during the fix): the `/:owner/:repo/wiki/*` wildcard had
// registered BEFORE `/:owner/:repo/wiki/blob_excerpt/:sha`, so even
// unshadowed the excerpt fetches 404'd on the page handler's drift guard —
// a58cad5 reordered specific-before-wildcard. The pins below keep guarding
// both layers.
describe("the window-2e wiki family claim (the escalated bug's pin — green since a58cad5)", () => {
  it("claims the bare, deep-tail and raw-tail wiki shapes for family wiki", () => {
    expect(parseUiRoute("/w107gal/w107wik/wiki")).toMatchObject({ family: "wiki", owner: "w107gal", repo: "w107wik", rawTail: "" });
    expect(parseUiRoute("/w107gal/w107wik/wiki/Home")).toMatchObject({ family: "wiki", rawTail: "Home" });
    expect(handlesUiRoute("/w107gal/w107wik/wiki")).toBe(true);
    expect(handlesUiRoute("/w107gal/w107wik/wiki/Home")).toBe(true);
    // The blob-excerpt twin keeps its exact 5-segment claim.
    expect(parseUiRoute("/w107gal/w107wik/wiki/blob_excerpt/abc")).toMatchObject({ family: "wiki-blob-excerpt", sha: "abc" });
  });

  it("serves the mounted view instead of the drift-guard plain 404", async () => {
    const res = await get("/w107gal/w107wik/wiki");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("repository wiki");
  });
});

// --- the hasWiki gate -------------------------------------------------------------

describe("the hasWiki gate (MustEnableWiki) 404-shells every wiki arm", () => {
  it("404s the read arms for anonymous and owner alike, indistinguishable from a missing repo", async () => {
    for (const path of [
      "/w107gal/w107nowiki/wiki",
      "/w107gal/w107nowiki/wiki/Home",
      "/w107gal/w107nowiki/wiki?action=_pages",
      "/w107gal/w107nowiki/wiki/Home?action=_revision",
    ]) {
      const anon = await get(path);
      expect(anon.status, path).toBe(404);
      const html = await anon.text();
      expect(html, path).toContain("status-page-error"); // the shell
      expect(html, path).not.toContain("repository wiki"); // no wiki DOM leaks
    }
    for (const path of ["/w107gal/w107nowiki/wiki?action=_new", "/w107gal/w107nowiki/wiki/Home?action=_edit"]) {
      expect((await get(path, OWNER)).status, path).toBe(404);
    }
  });

  it("404s the write arms and leaves the wiki cell unborn", async () => {
    const res = await postForm("/w107gal/w107nowiki/wiki?action=_new", { title: "Gate Bypass", content: "x", message: "" }, OWNER);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await wikiTipOf(env, await pairFor("w107nowiki"))).toBeUndefined(); // nothing landed
  });
});

// --- anonymous reads + the anonymous write gates ------------------------------------

describe("anonymous reads of a public wiki (and the anonymous write gates)", () => {
  it("renders the view of Home without any writer chrome", async () => {
    const res = await get(`${REPO_LINK}/wiki`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Home" class="page-content repository wiki">');
    expect(html).toContain('<h1 id="user-content-home-base">Home base</h1>');
    // The writer row, the New Page target and the delete modal are canWrite-gated.
    expect(html).not.toContain(`href="${REPO_LINK}/wiki/Home?action=_edit"`);
    expect(html).not.toContain(`href="${REPO_LINK}/wiki?action=_new"`);
    expect(html).not.toContain("repo-wiki-delete-page-modal");
  });

  it("renders _pages and _revision; the writer-gated GETs 404", async () => {
    const pages = await get(`${REPO_LINK}/wiki?action=_pages`);
    expect(pages.status).toBe(200);
    const pagesHtml = await pages.text();
    expect(pagesHtml).toContain(`<a href="${REPO_LINK}/wiki/Home">Home</a>`);
    expect(pagesHtml).not.toContain(`href="${REPO_LINK}/wiki?action=_new"`); // no New Page button

    const revision = await get(`${REPO_LINK}/wiki/Home?action=_revision`);
    expect(revision.status).toBe(200);
    const revisionHtml = await revision.text();
    expect(revisionHtml).toContain('<div class="sixteen wide column">1 Commits</div>');
    expect(revisionHtml).toContain("Add &quot;Home&quot;"); // the default create subject
    expect(revisionHtml).not.toContain("navigation_label"); // a single revision → no pager

    expect((await get(`${REPO_LINK}/wiki?action=_new`)).status).toBe(404);
    expect((await get(`${REPO_LINK}/wiki/Home?action=_edit`)).status).toBe(404);
  });

  it("404s every write POST despite the same-origin form (the anonymous canWrite=false arm)", async () => {
    expect((await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "Anon Page", content: "x", message: "" })).status).toBe(404);
    expect((await postForm(`${REPO_LINK}/wiki/Home?action=_edit`, { title: "", content: "hacked", message: "" })).status).toBe(404);
    expect((await postForm(`${REPO_LINK}/wiki/Home?action=_delete`, {})).status).toBe(404);
    // Nothing landed: the pages list never grows.
    const pages = await get(`${REPO_LINK}/wiki?action=_pages`);
    expect(await pages.text()).not.toContain("Anon Page");
  });
});

// --- the signed-in non-writer gates -------------------------------------------------

describe("the signed-in non-writer gates (public read, refused writes)", () => {
  it("admits the stranger's reads and 404-shells every write arm", async () => {
    const view = await get(`${REPO_LINK}/wiki`, STRANGER);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('<h1 id="user-content-home-base">Home base</h1>');

    expect((await get(`${REPO_LINK}/wiki?action=_new`, STRANGER)).status).toBe(404);
    expect((await get(`${REPO_LINK}/wiki/Home?action=_edit`, STRANGER)).status).toBe(404);

    expect(
      (await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "Stranger Page", content: "x", message: "" }, STRANGER)).status,
    ).toBe(404);
    expect((await postForm(`${REPO_LINK}/wiki/Home?action=_edit`, { title: "", content: "hacked", message: "" }, STRANGER)).status).toBe(404);
    expect((await postForm(`${REPO_LINK}/wiki/Home?action=_delete`, {}, STRANGER)).status).toBe(404);

    const pages = await get(`${REPO_LINK}/wiki?action=_pages`, STRANGER);
    expect(await pages.text()).not.toContain("Stranger Page"); // nothing landed
  });
});

// --- the archived repo --------------------------------------------------------------

describe("the archived repo (the RepoMustNotBeArchived half of the write grant)", () => {
  it("keeps reads open but 404-shells the writer's GETs and POSTs", async () => {
    const view = await get("/w107gal/w107arch/wiki", OWNER);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('<div role="main" aria-label="Wiki" class="page-content repository wiki start">');

    expect((await get("/w107gal/w107arch/wiki?action=_new", OWNER)).status).toBe(404);
    expect((await get("/w107gal/w107arch/wiki/Any?action=_edit", OWNER)).status).toBe(404);
    const res = await postForm("/w107gal/w107arch/wiki?action=_new", { title: "Archived Page", content: "x", message: "" }, OWNER);
    expect(res.status).toBe(404);
    expect(await wikiTipOf(env, await pairFor("w107arch"))).toBeUndefined(); // nothing landed
  });
});

// --- the validation texts (order-stable: only Home is needed) ------------------------

describe("the service's exact validation texts re-rendering the form", () => {
  it("refuses a reserved title with the carried value", async () => {
    const res = await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "_pages", content: "x", message: "" }, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">wiki title is reserved: _pages</div>');
    expect(html).toContain('<input name="title" value="_pages"'); // the carried title
  });

  it("refuses a duplicate with the coded git path in the message", async () => {
    const res = await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "Home", content: "dup", message: "" }, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">wiki page already exists [title: Home.md]</div>');
    expect(html).toContain('<input name="title" value="Home"');
  });
});

// --- the create round-trip -----------------------------------------------------------

describe("the create round-trip (NewWikiPost's write)", () => {
  it("303s onto the new sub_url and the fresh page renders anonymously", async () => {
    const res = await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "Round Trip", content: "# RT v1\n", message: "" }, OWNER);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${REPO_LINK}/wiki/Round-Trip`);

    const view = await get(`${REPO_LINK}/wiki/Round-Trip`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('<h1 id="user-content-rt-v1">RT v1</h1>');
  });
});

// --- the edit round-trip + rename semantics -------------------------------------------

describe("the edit round-trip and the rename semantics (EditWikiPost's write)", () => {
  it("keeps the name on an empty title, renames on a new one, and folds the old name to the missing 303", async () => {
    // The empty title keeps the old name (the op's binding-optional arm);
    // message "" → the default `Update %q(WebPath)` subject.
    const keep = await postForm(`${REPO_LINK}/wiki/Round-Trip?action=_edit`, { title: "", content: "# RT v2\n", message: "" }, OWNER);
    expect(keep.status).toBe(303);
    expect(keep.headers.get("location")).toBe(`${REPO_LINK}/wiki/Round-Trip`);
    const kept = await get(`${REPO_LINK}/wiki/Round-Trip`);
    expect(await kept.text()).toContain('<h1 id="user-content-rt-v2">RT v2</h1>');

    // The in-place history first: two commits on the matched git path,
    // newest first (the custom-message default order).
    const revision = await get(`${REPO_LINK}/wiki/Round-Trip?action=_revision`, OWNER);
    expect(revision.status).toBe(200);
    const revisionHtml = await revision.text();
    expect(revisionHtml).toContain('<div class="sixteen wide column">2 Commits</div>');
    const atUpdate = revisionHtml.indexOf("Update &quot;Round-Trip&quot;");
    const atAdd = revisionHtml.indexOf("Add &quot;Round Trip&quot;");
    expect(atUpdate).toBeGreaterThan(-1);
    expect(atAdd).toBeGreaterThan(atUpdate);

    // The rename: 303 onto the new sub_url; the old name goes missing.
    const rename = await postForm(
      `${REPO_LINK}/wiki/Round-Trip?action=_edit`,
      { title: "Renamed Page", content: "# RT v3\n", message: "rename it" },
      OWNER,
    );
    expect(rename.status).toBe(303);
    expect(rename.headers.get("location")).toBe(`${REPO_LINK}/wiki/Renamed-Page`);
    const oldName = await get(`${REPO_LINK}/wiki/Round-Trip`);
    expect(oldName.status).toBe(303);
    expect(oldName.headers.get("location")).toBe(PAGES_ACTION);
    const renamed = await get(`${REPO_LINK}/wiki/Renamed-Page`);
    expect(await renamed.text()).toContain('<h1 id="user-content-rt-v3">RT v3</h1>');

    // The revision list follows the MATCHED git path only — the renamed
    // page's log starts at the rename commit (no --follow).
    const renamedRevision = await get(`${REPO_LINK}/wiki/Renamed-Page?action=_revision`, OWNER);
    expect(renamedRevision.status).toBe(200);
    const renamedHtml = await renamedRevision.text();
    expect(renamedHtml).toContain('<div class="sixteen wide column">1 Commits</div>');
    expect(renamedHtml).toContain("rename it");
    expect(renamedHtml).not.toContain("Add &quot;Round Trip&quot;");
  });
});

// --- the missing-page arms ------------------------------------------------------------

describe("the missing-page arms (the wiki.go:238/340/400 folds)", () => {
  it("303s the view, _revision and the writer's _edit onto ?action=_pages", async () => {
    const view = await get(`${REPO_LINK}/wiki/Never-Was`);
    expect(view.status).toBe(303);
    expect(view.headers.get("location")).toBe(PAGES_ACTION);

    const revision = await get(`${REPO_LINK}/wiki/Never-Was?action=_revision`);
    expect(revision.status).toBe(303);
    expect(revision.headers.get("location")).toBe(PAGES_ACTION);

    const edit = await get(`${REPO_LINK}/wiki/Never-Was?action=_edit`, OWNER);
    expect(edit.status).toBe(303);
    expect(edit.headers.get("location")).toBe(PAGES_ACTION);
  });

  it("404s the anonymous _edit before any load and folds a ghost delete onto the same 303", async () => {
    expect((await get(`${REPO_LINK}/wiki/Never-Was?action=_edit`)).status).toBe(404); // the gate precedes the load
    const ghost = await postForm(`${REPO_LINK}/wiki/Never-Was?action=_delete`, {}, OWNER);
    // The delete's ApiError(404) folds through the edit re-render's missing
    // arm — the same _pages redirect, never a 500.
    expect(ghost.status).toBe(303);
    expect(ghost.headers.get("location")).toBe(PAGES_ACTION);
  });

  it("reads a claimed raw tail as a page name (the byte arm stays unimplemented)", async () => {
    const raw = await get(`${REPO_LINK}/wiki/raw/Home.md`);
    // The parser claims every wiki tail; "raw/…" is a reserved name that can
    // never exist, so the view arm's missing fold answers — not the shell,
    // not an engine 404.
    expect(raw.status).toBe(303);
    expect(raw.headers.get("location")).toBe(PAGES_ACTION);
  });
});

// --- the delete round-trip (LAST on w107wik — it consumes Home) ------------------------

describe("the delete round-trip (DeleteWikiPagePost's write)", () => {
  it("303s onto ?action=_pages, removes the page, and the bare tail deletes Home", async () => {
    // A page of its own so the arm is order-free.
    const seed = await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "Doomed Page", content: "x", message: "" }, OWNER);
    expect(seed.status).toBe(303);
    expect(seed.headers.get("location")).toBe(`${REPO_LINK}/wiki/Doomed-Page`);

    const del = await postForm(`${REPO_LINK}/wiki/Doomed-Page?action=_delete`, {}, OWNER);
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe(PAGES_ACTION);
    const gone = await get(`${REPO_LINK}/wiki/Doomed-Page`);
    expect(gone.status).toBe(303);
    expect(gone.headers.get("location")).toBe(PAGES_ACTION);

    // The BARE tail (rawTail "") means Home (wiki.go:730-731).
    const home = await postForm(`${REPO_LINK}/wiki?action=_delete`, {}, OWNER);
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe(PAGES_ACTION);
    const homeGone = await get(`${REPO_LINK}/wiki/Home`);
    expect(homeGone.status).toBe(303);
    expect(homeGone.headers.get("location")).toBe(PAGES_ACTION);
  });
});

// --- the no-wiki arms -----------------------------------------------------------------

describe("the no-wiki arms over a settings-enabled, branch-less repo", () => {
  it("renders tplWikiStart for the view — the create button is writer-gated", async () => {
    const anon = await get("/w107gal/w107bare/wiki");
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain('<div role="main" aria-label="Wiki" class="page-content repository wiki start">');
    expect(anonHtml).not.toContain('href="/w107gal/w107bare/wiki?action=_new"');

    const owner = await get("/w107gal/w107bare/wiki", OWNER);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain(
      '<a class="ui primary button tw-mr-0" href="/w107gal/w107bare/wiki?action=_new">Create the First Page</a>',
    );
  });

  it("renders the start page for _revision (parity) and for _pages/_edit (mounted arms — upstream 303s)", async () => {
    // _revision: upstream WikiRevision renders tplWikiStart too (wiki.go:507-511).
    const revision = await get("/w107gal/w107bare/wiki?action=_revision");
    expect(revision.status).toBe(200);
    expect(await revision.text()).toContain('<div role="main" aria-label="Wiki" class="page-content repository wiki start">');

    // _pages/_edit: upstream WikiPages (wiki.go:537-540) and EditWiki
    // (wiki.go:692-695) REDIRECT to /wiki on a branch-less wiki — the mount
    // renders the start page at 200 instead. PINNED AS-IS (a mounted-arm
    // divergence disclosed in the wave report; not asserted as parity).
    expect((await get("/w107gal/w107bare/wiki?action=_pages")).status).toBe(200);
    const edit = await get("/w107gal/w107bare/wiki?action=_edit", OWNER);
    expect(edit.status).toBe(200);
    expect(await edit.text()).toContain("repository wiki start");
  });

  it("renders the _new form with the mount's constant empty title (upstream prefills Home)", async () => {
    const res = await get("/w107gal/w107bare/wiki?action=_new", OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form class="ui form form-fetch-action" action="?action=_new" method="post">');
    // Upstream NewWiki prefills "Home" when the wiki branch is absent
    // (wiki.go:655-663); the mount passes "" unconditionally — PINNED AS-IS
    // (same disclosure).
    expect(html).toContain('<input name="title" value=""');
  });
});

// --- the same-origin guard -------------------------------------------------------------

describe("the §2.8 same-origin guard on the write arms", () => {
  it("403s a cross-origin POST before anything runs", async () => {
    const res = await postForm(`${REPO_LINK}/wiki?action=_new`, { title: "Evil Page", content: "x", message: "" }, OWNER, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("cross-origin request rejected\n");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Nothing landed.
    expect((await get(`${REPO_LINK}/wiki/Evil-Page`)).status).toBe(303);
  });
});

// --- the ?page= revision pager ----------------------------------------------------------

describe("the ?page= revision pager at CommitsRangeSize (50)", () => {
  it("counts all 55 revisions in the view's history button", async () => {
    const res = await get("/w107gal/w107pager/wiki/Pager");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Pager" class="page-content repository wiki">');
    expect(html).toContain('title="Page Revision" href="/w107gal/w107pager/wiki/Pager?action=_revision"><span>55</span>');
  });

  it("splits 55 revisions 50+5 with the Older/Newer hrefs (page 2's Newer folds onto the bare action URL)", async () => {
    const page1 = await get("/w107gal/w107pager/wiki/Pager?action=_revision");
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain('<div class="sixteen wide column">55 Commits</div>');
    expect(html1.split('class="commit-summary"').length - 1).toBe(50);
    expect(html1).toContain('title="pager rev 55"'); // newest first
    expect(html1).toContain('title="pager rev 6"'); // the 50th row
    expect(html1).not.toContain('title="pager rev 5"'); // the split is exact
    expect(html1).toContain('<a class="item navigation" href="/w107gal/w107pager/wiki/Pager?action=_revision&amp;page=2">');
    expect(html1).toContain("Older</span>");
    expect(html1).not.toContain("Newer</span>"); // nothing newer than page 1

    const page2 = await get("/w107gal/w107pager/wiki/Pager?action=_revision&page=2");
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2.split('class="commit-summary"').length - 1).toBe(5);
    expect(html2).toContain('title="pager rev 1"'); // the oldest
    // page <= 1 folds the Newer href onto the bare action URL (no page=1).
    expect(html2).toContain('<a class="item navigation" href="/w107gal/w107pager/wiki/Pager?action=_revision">');
    expect(html2).toContain("Newer</span>");
    expect(html2).not.toContain("Older</span>"); // the split is exact
  });

  it("renders the beyond-end page with only its Newer link, and folds junk pages onto page 1", async () => {
    const beyond = await get("/w107gal/w107pager/wiki/Pager?action=_revision&page=3");
    expect(beyond.status).toBe(200);
    const beyondHtml = await beyond.text();
    expect(beyondHtml.split('class="commit-summary"').length - 1).toBe(0); // past the end
    expect(beyondHtml).toContain('<div class="sixteen wide column">55 Commits</div>'); // the true count
    expect(beyondHtml).toContain("Newer</span>"); // the walk-back link to page 2
    expect(beyondHtml).not.toContain("Older</span>");

    const junk = await get("/w107gal/w107pager/wiki/Pager?action=_revision&page=abc");
    expect(junk.status).toBe(200);
    const junkHtml = await junk.text();
    expect(junkHtml.split('class="commit-summary"').length - 1).toBe(50); // parsePageNumber folds to page 1
    expect(junkHtml).toContain("Older</span>");
  });
});
