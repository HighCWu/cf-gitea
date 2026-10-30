/**
 * The usability B-4 suite: the repo-header trio's POST action arms (pages/
 * repo-header-actions.tsx) + the clone panel's markup contract (pages/
 * home.tsx's RepoClonePanel / RepoCloneButtonsCombo).
 *
 * The action arms are driven through the exported builders on REAL D1
 * bindings (the forks matrix's fixtures shape — D1-only, no engine): the
 * write lands through the landed stars/repo-watchers services' guarded
 * batches, the counters move with the edge, and the response body is the
 * FRAGMENT the official bundle's fetch-action module swaps into the page
 * (upstream renders repo/header/star.tmpl / repo/header/watch.tmpl alone,
 * routers/web/repo/star.go:24-31 + watch.go:34-46). The route-level POST
 * mounts live in ui/index.ts (the HANDOFF recipe — the thin adapter wraps
 * these builders with the §2.8 sameOriginGuard + resolveUiRequest
 * prologue); the negative "unclaimed" pins they replace live in the forks
 * matrix's last describe (recipe item 3).
 */

import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { findForkByOwner } from "../../api/services/forks";
import { watchRepo } from "../../api/services/repo-watchers";
import { starRepo } from "../../api/services/stars";
import { repositories, repoWatchers, stars, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { httpsCloneUrl, RepoCloneButtonsCombo, RepoClonePanel } from "./home";
import {
  loadRepoHeaderActionState,
  renderRepoHeaderStarFragment,
  renderRepoHeaderWatchFragment,
  repoStarActionResponse,
  repoWatchActionResponse,
} from "./repo-header-actions";
import { renderToString } from "hono/jsx/dom/server";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

// --- the clone panel markup (pure components) ---------------------------------

const ORIGIN = "https://test.local";

describe("the clone panel markup (B-4)", () => {
  it("renders the initRepoClonePanel button with its adjacent tippy popup (the bundle's nextElementSibling contract)", () => {
    const html = renderToString(
      <RepoClonePanel cloneUrl="https://test.local/octocat/hello.git" archivePrefix="/octocat/hello/archive/main" />,
    );
    // The dropdown trigger + the popup div IMMEDIATELY after it (repo-common.ts:131).
    expect(html).toContain('<button type="button" class="ui compact primary button" data-global-init="initRepoClonePanel">');
    expect(html).toContain('<span>Code</span>');
    const buttonEnd = html.indexOf("</button>");
    const popupStart = html.indexOf('<div class="clone-panel-popup tippy-target">');
    expect(popupStart).toBeGreaterThan(0);
    expect(html.slice(buttonEnd, popupStart)).toBe("</button>");
    // The header row + the HTTPS-only tab (the documented divergence: no SSH,
    // no Tea) with the data-link the combo JS reads.
    expect(html).toContain('<div class="flex-text-block clone-panel-field">');
    expect(html).toContain('<div class="clone-panel-tab"><button type="button" class="item repo-clone-https" data-link="https://test.local/octocat/hello.git">HTTPS</button></div>');
    expect(html).not.toContain("repo-clone-ssh");
    expect(html).not.toContain("repo-clone-tea");
    // The URL field: the readonly js-clone-url input + the copy button whose
    // data-clipboard-target scopes the popup's input class.
    expect(html).toContain(
      '<input size="30" class="repo-clone-url js-clone-url" value="https://test.local/octocat/hello.git" readonly=""/>',
    );
    expect(html).toContain('data-clipboard-target=".js-clone-url" data-tooltip-content="Copy URL" aria-label="Copy URL"');
    expect(html).toContain('class="svg octicon-copy"');
    // The download arms ride the landed archive route suffixes; no bundle
    // (the builder refuses the format — a dead link).
    expect(html).toContain('<a class="item muted archive-link" href="/octocat/hello/archive/main.zip" rel="nofollow">');
    expect(html).toContain('<a class="item muted archive-link" href="/octocat/hello/archive/main.tar.gz" rel="nofollow">');
    expect(html).toContain("Download ZIP");
    expect(html).toContain("Download TAR.GZ");
    expect(html).not.toContain("Download BUNDLE");
  });

  it("renders the empty-repo combo with its own clipboard scope", () => {
    const html = renderToString(<RepoCloneButtonsCombo cloneUrl="https://test.local/octocat/hello.git" />);
    expect(html).toContain('<div class="ui action small input clone-buttons-combo" data-global-init="initRepoCloneButtonsCombo">');
    expect(html).toContain('<button type="button" class="ui small button repo-clone-https" data-link="https://test.local/octocat/hello.git">HTTPS</button>');
    expect(html).toContain('<input size="10" class="repo-clone-url js-clone-url" value="https://test.local/octocat/hello.git" readonly=""/>');
    expect(html).toContain('data-clipboard-target=".repo-clone-url"');
  });

  it("builds the upstream ComposeHTTPSCloneURL shape", () => {
    expect(httpsCloneUrl(ORIGIN, "octocat", "hello")).toBe("https://test.local/octocat/hello.git");
    expect(httpsCloneUrl("https://git.example.com", "a.b", "c d")).toBe("https://git.example.com/a.b/c d.git");
  });
});

// --- the action arms (real D1) --------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000);

interface B4Fixture {
  repoId: string;
  owner: { id: number; username: string };
  starer: { id: number; username: string };
}

let b4: B4Fixture | null = null;

async function ensureFixtures(): Promise<B4Fixture> {
  if (b4 !== null) return b4;
  await applyAuthD1Migrations();
  const owner = await seedVerifiedUser({ username: "b4-owner" });
  const starer = await seedVerifiedUser({ username: "b4-starer" });
  const row = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "b4-owner" },
    name: "paint",
    isPrivate: false,
    status: "ready",
  });
  b4 = { repoId: row.id, owner, starer };
  return b4;
}

beforeAll(async () => {
  await ensureFixtures();
});

function userRow(seed: { id: number; username: string }): Extract<Viewer, { kind: "user" }> {
  return { kind: "user", id: seed.id, username: seed.username, isAdmin: false };
}

async function repoRow(repoId: string): Promise<RepoRow> {
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (row === undefined) throw new Error("fixture repo row missing");
  return row;
}

async function counters(repoId: string, userId: number): Promise<{ repoStars: number; userStars: number; repoWatches: number; starRows: number; watchRows: number }> {
  const repo = await drizzle(env.DB).select({ n: repositories.numStars, w: repositories.numWatches }).from(repositories).where(eq(repositories.id, repoId)).get();
  const user = await drizzle(env.DB).select({ n: users.numStars }).from(users).where(eq(users.id, userId)).get();
  const starRows = await drizzle(env.DB).select({ n: sql<number>`count(*)` }).from(stars).where(eq(stars.repoId, repoId)).get();
  const watchRows = await drizzle(env.DB).select({ n: sql<number>`count(*)` }).from(repoWatchers).where(eq(repoWatchers.repoId, repoId)).get();
  return {
    repoStars: repo?.n ?? 0,
    userStars: user?.n ?? 0,
    repoWatches: repo?.w ?? 0,
    starRows: starRows?.n ?? 0,
    watchRows: watchRows?.n ?? 0,
  };
}

describe("the star action arm (upstream ActionStar)", () => {
  it("stars: 200 text/html fragment with the filled glyph + Unstar POST, counters moved", async () => {
    const f = await ensureFixtures();
    const repo = await repoRow(f.repoId);
    const res = await repoStarActionResponse(env.DB, repo, userRow(f.starer), "star");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    const html = await res.text();
    // The fragment is the ANCHOR ALONE (the $this sync target) — not the
    // watch div, not a page.
    expect(html).toContain('aria-label="Unstar" data-fetch-method="post" data-fetch-url="/b4-owner/paint/action/unstar"');
    expect(html).toContain('class="svg octicon-star-fill"');
    expect(html).toContain('<span class="ui small label">1</span>');
    expect(html).not.toContain("repo-header-watch");
    expect(html.startsWith("<a ")).toBe(true);
    // The write landed: edge + both counters (the services' one-batch shape).
    expect(await counters(f.repoId, f.starer.id)).toEqual({ repoStars: 1, userStars: 1, repoWatches: 0, starRows: 1, watchRows: 0 });
  });

  it("is idempotent (a repeat star moves nothing) and unstar restores the hollow glyph + zero counters", async () => {
    const f = await ensureFixtures();
    const repo = await repoRow(f.repoId);
    const again = await repoStarActionResponse(env.DB, repo, userRow(f.starer), "star");
    expect(await counters(f.repoId, f.starer.id)).toEqual({ repoStars: 1, userStars: 1, repoWatches: 0, starRows: 1, watchRows: 0 });
    expect(await again.text()).toContain('<span class="ui small label">1</span>');

    const off = await repoStarActionResponse(env.DB, repo, userRow(f.starer), "unstar");
    const offHtml = await off.text();
    expect(offHtml).toContain('aria-label="Star" data-fetch-method="post" data-fetch-url="/b4-owner/paint/action/star"');
    expect(offHtml).toContain('class="svg octicon-star"');
    expect(offHtml).toContain('<span class="ui small label">0</span>');
    expect(await counters(f.repoId, f.starer.id)).toEqual({ repoStars: 0, userStars: 0, repoWatches: 0, starRows: 0, watchRows: 0 });
  });
});

describe("the watch action arm (upstream ActionWatch's two representable cases)", () => {
  it("watch: 200 fragment with the Watching button + checked All-activity item, num_watches moved", async () => {
    const f = await ensureFixtures();
    const repo = await repoRow(f.repoId);
    const res = await repoWatchActionResponse(env.DB, repo, userRow(f.owner), "watch");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    const html = await res.text();
    // The fragment is the whole #repo-header-watch div (the sync target).
    expect(html.startsWith('<div id="repo-header-watch" class="flex-text-block">')).toBe(true);
    expect(html).toContain('data-global-init="initRepoWatchMenu" aria-label="Watching"');
    expect(html).toContain('<a class="item active" role="menuitem" aria-label="All activity" data-fetch-method="post" data-fetch-url="/b4-owner/paint/action/watch"');
    expect(html).toContain('<a class="item" role="menuitem" aria-label="Participating and mentions" data-fetch-method="post" data-fetch-url="/b4-owner/paint/action/participate"');
    expect(html).toContain('<span class="ui small label">1</span>');
    expect(await counters(f.repoId, f.owner.id)).toEqual({ repoStars: 0, userStars: 0, repoWatches: 1, starRows: 0, watchRows: 1 });
  });

  it("participate: the row's absence is the state (WatchModeNone) — the fragment flips back to Watch, the counter follows", async () => {
    const f = await ensureFixtures();
    const repo = await repoRow(f.repoId);
    const res = await repoWatchActionResponse(env.DB, repo, userRow(f.owner), "participate");
    const html = await res.text();
    expect(html).toContain('data-global-init="initRepoWatchMenu" aria-label="Watch"');
    expect(html).toContain('<a class="item active" role="menuitem" aria-label="Participating and mentions"');
    expect(html).toContain('<span class="ui small label">0</span>');
    expect(await counters(f.repoId, f.owner.id)).toEqual({ repoStars: 0, userStars: 0, repoWatches: 0, starRows: 0, watchRows: 0 });
  });
});

// A synthetic row + viewer for the pure fragment renderers (no D1 — the
// shell suite's makeRepoRow shape, the b4-owner path literals).
function syntheticRepo(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: "b4synthetic",
    storageKey: "b4synthetic",
    ownerNamespace: "b4-owner",
    ownerId: 1,
    slug: "paint",
    visibility: "public",
    defaultBranch: "main",
    isEmpty: false,
    isArchived: false,
    status: "ready",
    refsVersion: 1,
    backend: "self-hosted",
    numIssues: 0,
    numClosedIssues: 0,
    numPulls: 0,
    numClosedPulls: 0,
    numMilestones: 0,
    closeIssuesViaCommitInAnyBranch: false,
    createdAt: T0,
    updatedAt: null,
    forkParent: null,
    isMirror: false,
    originalUrl: null,
    isTemplate: false,
    sizeKb: 0,
    numStars: 0,
    numWatches: 0,
    numForks: 0,
    ...overrides,
  };
}

describe("the fragment renderers (pure — the same bytes the responses carry)", () => {
  const viewer: Extract<Viewer, { kind: "user" }> = { kind: "user", id: 42, username: "b4-starer", isAdmin: false };

  it("renderRepoHeaderStarFragment renders the anchor over any row + state", () => {
    const html = renderRepoHeaderStarFragment(syntheticRepo({ numStars: 4 }), viewer, false);
    expect(html).toContain('aria-label="Star" data-fetch-method="post" data-fetch-url="/b4-owner/paint/action/star"');
    expect(html).toContain('class="svg octicon-star"');
    expect(html).toContain('<span class="ui small label">4</span>');
    expect(renderRepoHeaderStarFragment(syntheticRepo(), viewer, true)).toContain("octicon-star-fill");
  });

  it("renderRepoHeaderWatchFragment renders the whole div over any row + state", () => {
    const html = renderRepoHeaderWatchFragment(syntheticRepo({ numWatches: 9 }), viewer, true);
    expect(html.startsWith('<div id="repo-header-watch" class="flex-text-block">')).toBe(true);
    expect(html).toContain('data-global-init="initRepoWatchMenu" aria-label="Watching"');
    expect(html).toContain('<span class="ui small label">9</span>');
    expect(renderRepoHeaderWatchFragment(syntheticRepo(), viewer, false)).toContain('aria-label="Watch">');
  });
});

describe("loadRepoHeaderActionState (the loader recipe's probe)", () => {
  it("probes watch, star, and the doer's fork; the fork arm resolves once the edge exists", async () => {
    const f = await ensureFixtures();
    const db = drizzle(env.DB);
    // Clean slate for the starer: nothing starred/watched/forked.
    expect(await loadRepoHeaderActionState(env.DB, f.repoId, f.starer.id)).toEqual({
      watching: false,
      starring: false,
      fork: null,
    });
    // Star + watch through the landed services.
    await starRepo(env.DB, f.starer.id, f.repoId, T0);
    await watchRepo(env.DB, f.repoId, f.starer.id, T0);
    expect(await loadRepoHeaderActionState(env.DB, f.repoId, f.starer.id)).toEqual({
      watching: true,
      starring: true,
      fork: null,
    });
    // A fork edge (direct forkParent — RepoService.create has no fork input,
    // the forks matrix's convention).
    const forkRow = await new RepoService(env.DB).create({
      owner: { id: f.starer.id, usernameLower: "b4-starer" },
      name: "paint-fork",
      isPrivate: false,
      status: "ready",
    });
    await db.update(repositories).set({ forkParent: f.repoId }).where(eq(repositories.id, forkRow.id));
    expect(await loadRepoHeaderActionState(env.DB, f.repoId, f.starer.id)).toEqual({
      watching: true,
      starring: true,
      fork: { ownerNamespace: "b4-starer", slug: "paint-fork" },
    });
    expect(await findForkByOwner(env.DB, f.repoId, f.starer.id)).toEqual({ id: forkRow.id, ownerNamespace: "b4-starer", slug: "paint-fork" });
  });
});
