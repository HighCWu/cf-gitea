/**
 * The SITE HOME's deferred matrix (pages/dashboard.tsx — the site root `/`,
 * pages wave 9): the route-level arms the wave-9 block left open, driven
 * through the REAL routes on the settings-basics 4ef37cb matrix's
 * minted-session pattern (per-test D1 wipes, per-request session mints,
 * synthetic ASSETS manifest, execution contexts awaited) —
 *
 *   - the viewer-kind discrimination's UNCOVERED halves: the signed-in
 *     dashboard carries no landing marks (and the `<title>`s / logo
 *     aria-labels flip with the session), a stale session cookie degrades
 *     to the LANDING with the §2.4 clear-cookie directive, and a query
 *     string never leaves the pathname,
 *   - the claim pin: the site root is exactly `/` — the `//` shape is
 *     nobody's (the empty-segment pre-filter), a one-tail path belongs to
 *     the owner-home family, and POST / is unclaimed (GET-only),
 *   - the own-repo list's shapes: the wave-19 heading create-links ride the
 *     OWN list's heading (one muted pair, beside the shell navbar's own
 *     pair), rows order slug-alphabetical regardless of
 *     insertion order, the DASHBOARD_LIST_LIMIT cap bounds the read, and a
 *     stored settings description rides the row,
 *   - the org boundary: a doer's org-owned repos never surface on the
 *     personal dashboard (the documented v1 reduction),
 *   - the watched list through the SHARED readGrant's uncovered tiers: a
 *     LIMITED owner's public repo is visible authenticated with NO badge, a
 *     PRIVATE owner's public repo and a PROHIBITED owner's repo never
 *     surface, while the owner themself (isOwner) and a site admin
 *     (isSiteAdmin) keep the private-owner repo — badged "Internal" (the
 *     public-repo-under-private-owner rule),
 *   - and the fresh-account empty shape: both repo lists render their empty
 *     lines (the wave-9 block pinned the activity empty only).
 *
 * Batch-5 deepening (wave-polish-matrix-5) adds:
 *
 *   - the activity feed's DATA arms (wave 9 pinned one thread + the empty):
 *     the five-line cap with the `lastActivity DESC, id DESC` order — the
 *     tie pair collapsing to the higher id, the sixth thread falling off —
 *     the SELF-ACTIVITY exclusion (a viewer's own comment never dates a
 *     thread: lastActivityExpr's `<> userId` arm), and the state glyphs
 *     (the closed issue's red octicon-issue-closed, the PR's
 *     octicon-git-pull-request — the merged/WIP collapse documented on
 *     ActivityIcon, the shared/issueicon.tmpl reduction);
 *   - the org-list arm: a doer who owns an org still renders NO dashboard
 *     navbar — upstream's user/dashboard/navbar.tmpl context-user switch
 *     (its `context-user-switch` dropdown, the switch_dashboard_context
 *     header, the org-visibility labels, the Issues/Pulls/Milestones
 *     dashboard tabs) is the module header's documented reduction;
 *   - the navbar bell seam over THIS route: the per-request unread count
 *     (index.ts's resolveUiSession read) renders the visible
 *     .notification_count with the count on a recipient of a foreign
 *     comment, and the tw-hidden zero on a fresh principal — the seam
 *     pages-wave10 pins over /notifications only.
 *
 * The wave-9 positives (landing render, own public+private rows, the
 * granted/foreign-private watched pair, the one activity thread, the
 * per-user mailbox) are NOT re-pinned here; the activity column's thread
 * semantics stay the notifications tests' subject.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { watchRepo } from "../../api/services/repo-watchers";
import { repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { OrgService } from "../../services/orgs/orgs";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { type UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

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

/** The real production path (parse → resolveUiSession → load → render) on
 *  the mounted uiRouter; the execution context is awaited so waitUntil
 *  side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path, minted per request — the beforeEach users wipe cascades the
 *  sessions table; the value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

let repoSeq = 0;

/** A row-only repository (the wave-9 sibling pattern — the dashboard lists
 *  read D1 only, no engine content). */
async function seedRepoRow(
  owner: { id: number; usernameLower: string },
  slug: string,
  visibility: "public" | "private",
): Promise<string> {
  repoSeq += 1;
  const id = `dmx-${repoSeq}`;
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: id,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug,
    visibility,
  });
  return id;
}

interface SeedUserOptions {
  visibility?: "public" | "limited" | "private";
  isAdmin?: boolean;
  status?: "active" | "prohibited";
}

async function seedUser(username: string, opts: SeedUserOptions = {}): Promise<{ id: number; usernameLower: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: opts.status ?? "active",
      visibility: opts.visibility ?? "public",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return { id: row.id, usernameLower: row.usernameLower };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // Child-first (the SPEC's single FK: repo_counters.repo_id → repositories).
  for (const table of [
    "sessions",
    "repo_watchers",
    "repo_settings",
    "repo_counters",
    "repositories",
    "org_members",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the viewer-kind discrimination (the uncovered halves) ----------------------

describe("the site-home discriminator (anonymous landing vs signed-in dashboard)", () => {
  it("the signed-in dashboard carries no landing marks; the titles and logo labels flip with the session", async () => {
    const viewer = await seedUser("discriminator");
    const signedIn = await fetchUi("/", { headers: { cookie: await sessionHeader(viewer.id) } });
    expect(signedIn.status).toBe(200);
    const html = await signedIn.text();
    expect(html).toContain("<title>Dashboard - cf-gitea</title>");
    expect(html).toContain('<div role="main" aria-label="Dashboard" class="page-content dashboard feeds">');
    expect(html).toContain('id="navbar-logo" href="/" aria-label="Dashboard"');
    // The landing half never leaks onto the dashboard (the reverse of the
    // wave-9 block's no-leak assertion, which ran landing-side only).
    expect(html).not.toContain("page-content home");
    expect(html).not.toContain('<h1 class="ui icon header title">');
    expect(html).not.toContain("A painless, self-hosted Git service");
    expect(html).not.toContain("<title>Home - cf-gitea</title>");

    const anon = await fetchUi("/");
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain("<title>Home - cf-gitea</title>");
    expect(anonHtml).toContain('id="navbar-logo" href="/" aria-label="Home"');
    expect(anonHtml).not.toContain('aria-label="Dashboard"');
  });

  it("a stale session cookie degrades to the LANDING with the §2.4 clear-cookie directive", async () => {
    const res = await fetchUi("/", { headers: { cookie: `${SESSION_COOKIE_NAME}=deadbeef` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content home"); // the landing, not a crash
    expect(html).not.toContain("dashboard feeds");
    expect(res.headers.get("set-cookie")).toBe(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  });

  it("a query string never leaves the pathname: signed-in still gets the dashboard, anonymous the landing", async () => {
    const viewer = await seedUser("querier");
    const signedIn = await fetchUi("/?q=site-home", { headers: { cookie: await sessionHeader(viewer.id) } });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toContain("page-content dashboard feeds");

    const anon = await fetchUi("/?q=site-home");
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain("page-content home");
  });
});

// --- the claim pin (the site root is exactly /) ----------------------------------

describe("the claim pin (the site root is exactly /)", () => {
  it("the // shape is nobody's (the empty-segment pre-filter); a one-tail path is an owner home, never the site root", () => {
    expect(parseUiRoute("//")).toBeNull();
    expect(handlesUiRoute("//")).toBe(false);
    expect(parseUiRoute("/")).toEqual({ family: "site-home" });
    expect(handlesUiRoute("/")).toBe(true);
    expect(parseUiRoute("/dashboard")).toEqual({ family: "owner-home", owner: "dashboard" });
  });

  it("POST / is unclaimed (the registration is GET-only)", async () => {
    const res = await fetchUi("/", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// --- the own-repo list shapes ----------------------------------------------------

describe("the own-repo list shapes (create-links, order, cap, description)", () => {
  it("the wave-19 heading create-links ride the OWN list: the navbar pair plus one muted heading pair each", async () => {
    const owner = await seedUser("linked");
    await seedRepoRow(owner, "linked-one", "public");
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(owner.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The signed-in shell navbar carries the same pair (shell.tsx's create
    // menu), so the DOCUMENT carries two of each href: the navbar item and
    // the dashboard heading's link — both with the upstream tooltips.
    expect((html.match(/href="\/repo\/create"/g) ?? []).length).toBe(2);
    expect((html.match(/href="\/org\/create"/g) ?? []).length).toBe(2);
    expect(html).toContain('href="/repo/create" data-tooltip-content="New Repository" aria-label="New Repository"');
    expect(html).toContain('href="/org/create" data-tooltip-content="New Organization" aria-label="New Organization"');
    // The heading variant is the MUTED pair — exactly one each, and it sits
    // inside the OWN list's heading block (between the "Repositories" h2 and
    // the watched list's heading — the watched list renders none).
    expect((html.match(/class="tw-flex tw-items-center muted" href="\/repo\/create"/g) ?? []).length).toBe(1);
    expect((html.match(/class="tw-flex tw-items-center muted" href="\/org\/create"/g) ?? []).length).toBe(1);
    const ownHeading = html.indexOf("<h2>Repositories</h2>");
    const mutedRepoLink = html.indexOf('class="tw-flex tw-items-center muted" href="/repo/create"');
    const watchedHeading = html.indexOf("<h2>Watched Repositories</h2>");
    expect(ownHeading).toBeGreaterThan(-1);
    expect(mutedRepoLink).toBeGreaterThan(ownHeading);
    expect(mutedRepoLink).toBeLessThan(watchedHeading);
  });

  it("rows order slug-alphabetical regardless of insertion order", async () => {
    const owner = await seedUser("orderly");
    for (const slug of ["r-c", "r-a", "r-b"]) {
      await seedRepoRow(owner, slug, "public");
    }
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(owner.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const a = html.indexOf('href="/orderly/r-a"');
    const b = html.indexOf('href="/orderly/r-b"');
    const c = html.indexOf('href="/orderly/r-c"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("the DASHBOARD_LIST_LIMIT cap bounds the read: 16 own rows render 15, the alphabetical tail drops", async () => {
    const owner = await seedUser("capped");
    for (let i = 1; i <= 16; i++) {
      await seedRepoRow(owner, `cap-${String(i).padStart(2, "0")}`, "public");
    }
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(owner.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/capped/cap-15"');
    expect(html).not.toContain('href="/capped/cap-16"');
  });

  it("a stored settings description rides the row; an undescribed row renders none", async () => {
    const owner = await seedUser("described");
    const withText = await seedRepoRow(owner, "described-yes", "public");
    await seedRepoRow(owner, "described-no", "public");
    await saveRepoSettings(env.DB, withText, { description: "the stored description" }, new Date());
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(owner.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<div class=\"item-body\">the stored description</div>");
    expect(html).toContain('<a class="tw-text-primary name" href="/described/described-yes">');
  });
});

// --- the org boundary -------------------------------------------------------------

describe("the org boundary (org-owned repos never surface on the personal dashboard)", () => {
  it("a doer who owns an org with repos lists only the personal rows", async () => {
    const dana = await seedUser("dana");
    await seedRepoRow(dana, "personal", "public");
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "dashorg", ownerId: dana.id, visibility: "public", now: new Date() });
    await seedRepoRow({ id: org.id, usernameLower: "dashorg" }, "orgrepo", "public");

    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(dana.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/dana/personal"');
    expect(html).not.toContain("/dashorg/orgrepo");
    expect(html).not.toContain('href="/dashorg"');
  });
});

// --- the watched list through the shared readGrant (self vs others) ---------------

describe("the watched list through the shared readGrant (self vs others)", () => {
  /** The tier fixtures: a LIMITED and a PRIVATE-visibility owner and a
   *  PROHIBITED owner, each holding one PUBLIC repo — the readGrant tiers
   *  the wave-9 block's public/foreign-private pair did not exercise. */
  async function seedWatchTiers(): Promise<{ limRepoId: string; pvRepoId: string; deadRepoId: string }> {
    const lim = await seedUser("lim", { visibility: "limited" });
    const pv = await seedUser("pv", { visibility: "private" });
    const dead = await seedUser("dead", { status: "prohibited" });
    const limRepoId = await seedRepoRow(lim, "limpub", "public");
    const pvRepoId = await seedRepoRow(pv, "pvpub", "public");
    const deadRepoId = await seedRepoRow(dead, "deadpub", "public");
    return { limRepoId, pvRepoId, deadRepoId };
  }

  it("a LIMITED owner's public repo is visible to a signed-in watcher with NO badge; a PRIVATE owner's and a PROHIBITED owner's never surface", async () => {
    const watcher = await seedUser("watcher");
    const { limRepoId, pvRepoId, deadRepoId } = await seedWatchTiers();
    for (const repoId of [limRepoId, pvRepoId, deadRepoId]) {
      await watchRepo(env.DB, repoId, watcher.id, new Date());
    }
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(watcher.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Limited: the authenticated grant (readGrant's limited-owner branch) —
    // and limited is NOT private, so no Internal badge anywhere.
    expect(html).toContain("Watched Repositories");
    expect(html).toContain('href="/lim/limpub"');
    expect(html).not.toContain("Internal</span>");
    // Private-owner public repo: owner/admin-only — never the watcher's.
    expect(html).not.toContain("/pv/pvpub");
    // Prohibited owner: the active-owner clause filters the public row too.
    expect(html).not.toContain("/dead/deadpub");
  });

  it("the PRIVATE owner themself keeps the repo in BOTH lists (isOwner), badged Internal in each", async () => {
    const pv = await seedUser("pv", { visibility: "private" });
    const pvRepoId = await seedRepoRow(pv, "pvpub", "public");
    await watchRepo(env.DB, pvRepoId, pv.id, new Date());
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(pv.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Own list + watched list: the same repo row twice (isOwner grants both).
    expect((html.match(/href="\/pv\/pvpub"/g) ?? []).length).toBe(2);
    expect((html.match(/Internal<\/span>/g) ?? []).length).toBe(2);
    expect(html).not.toContain("Private</span>"); // the REPO is public — the owner's visibility badges it
  });

  it("a site admin watcher keeps the private-owner repo (readGrant's isSiteAdmin arm), badged Internal", async () => {
    const admin = await seedUser("rooty", { isAdmin: true });
    const { pvRepoId } = await seedWatchTiers();
    await watchRepo(env.DB, pvRepoId, admin.id, new Date());
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(admin.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/pv/pvpub"');
    expect(html).toContain("Internal</span>");
    expect(html).not.toContain("/lim/limpub"); // not watched — only the watched grant is under test
  });
});

// --- the fresh-account empty shape -------------------------------------------------

describe("the fresh-account empty shape", () => {
  it("a brand-new user sees both repo-list empty lines and keeps the create-links", async () => {
    const newly = await seedUser("newly");
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(newly.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No repositories yet.");
    expect(html).toContain("No watched repositories.");
    expect(html).toContain("No recent activity."); // the wave-9 line, for the same fresh principal
    expect(html).toContain('href="/repo/create"');
    expect(html).not.toContain("flex-divided-list"); // no list body rendered at all
  });
});

// --- batch-5: the activity feed's data arms ------------------------------------------

describe("the activity feed's data arms (order, cap, glyphs, the self-activity exclusion)", () => {
  /** The feed world: the viewer owns the repo; a foreign poster comments on
   *  six threads at staggered stamps (two sharing one — the id-DESC tie
   *  pair), one thread carries only the viewer's OWN comment (newest activity
   *  on the page, yet no thread), one issue is closed, one is a pull. */
  async function seedFeedWorld(): Promise<{ viewerId: number; foreign: { id: number } }> {
    const viewer = await seedUser("feeder");
    const foreign = await seedUser("feign");
    const repoId = await seedRepoRow(viewer, "feedmx", "public");
    const svc = new IssuesService(env.DB);
    const T = 1_700_000_500;
    const at = (offset: number): Date => new Date((T + offset) * 1000);

    const thread = async (title: string, commentAt: number, opts: { close?: boolean; pull?: boolean } = {}) => {
      // createIssue returns the issue row; createPullRequest wraps it in
      // { issue } (the issues-search-aux seeding's same shapes).
      const issue = opts.pull
        ? (
            await svc.createPullRequest({
              repoId,
              title,
              posterId: viewer.id,
              headRepoId: repoId,
              baseBranch: "main",
              headBranch: `feat-${title.slice(-3)}`,
              now: at(0),
            })
          ).issue
        : await svc.createIssue({ repoId, title, posterId: viewer.id, now: at(0) });
      if (opts.close) await svc.closeIssue(issue.id, { now: at(5) });
      await svc.addComment({ issueId: issue.id, posterId: foreign.id, content: "foreign stamp", now: at(commentAt) });
      return issue;
    };

    // Six recipient threads: 90/80/70/60/20/20 — the last two share a stamp
    // (the id-DESC tiebreak; created in order, so the later issue wins the
    // earlier slot) and the fifth-oldest pair straddles the five-line cap.
    await thread("feedmx alpha thread", 90);
    await thread("feedmx beta thread", 80);
    await thread("feedmx closed thread", 70, { close: true });
    await thread("feedmx pull thread", 60, { pull: true });
    await thread("feedmx tie-low thread", 20);
    await thread("feedmx tie-high thread", 20);

    // The viewer's OWN comment is the newest activity on the page, yet it
    // dates no thread (lastActivityExpr's foreign-authored arm).
    const selfRow = await svc.createIssue({ repoId, title: "feedmx self-only thread", posterId: viewer.id, now: at(0) });
    await svc.addComment({ issueId: selfRow.id, posterId: viewer.id, content: "self stamp", now: at(95) });

    return { viewerId: viewer.id, foreign };
  }

  it("renders five lines in lastActivity-DESC order; the tie pair collapses to the higher id and the sixth thread falls off", async () => {
    const { viewerId } = await seedFeedWorld();
    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(viewerId) } });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The five lines: 90 → 80 → 70 → 60 → the tie at 20 resolved by id DESC
    // (tie-high created after tie-low), tie-low capped off. Each anchor is
    // the issue-detail link `#<index>` line title.
    const alpha = html.indexOf("feedmx alpha thread");
    const beta = html.indexOf("feedmx beta thread");
    const closed = html.indexOf("feedmx closed thread");
    const pull = html.indexOf("feedmx pull thread");
    const tieHigh = html.indexOf("feedmx tie-high thread");
    expect(alpha).toBeGreaterThan(-1);
    expect(beta).toBeGreaterThan(alpha);
    expect(closed).toBeGreaterThan(beta);
    expect(pull).toBeGreaterThan(closed);
    expect(tieHigh).toBeGreaterThan(pull);
    expect(html).not.toContain("feedmx tie-low thread"); // the cap's casualty
    expect(html).not.toContain("feedmx self-only thread"); // never a thread at all
    // Five `#activity-feed` rows exactly (the DASHBOARD_ACTIVITY_LIMIT) —
    // the slice stops at the sidebar, whose repo rows share the item class.
    const feedSlice = html.slice(
      html.indexOf('id="activity-feed"'),
      html.indexOf('id="dashboard-repo-list"'),
    );
    expect((feedSlice.match(/<div class="item">/g) ?? []).length).toBe(5);
  });

  it("the self-authored activity never dates a thread even when it is the newest event", async () => {
    const { viewerId } = await seedFeedWorld();
    const html = await (await fetchUi("/", { headers: { cookie: await sessionHeader(viewerId) } })).text();
    // The self comment (T+95) postdates every foreign stamp (latest T+90);
    // the thread still does not render — the recipient/foreign predicate.
    expect(html).not.toContain("feedmx self-only thread");
    expect(html).toContain("feedmx alpha thread"); // the control: a foreign thread does
  });

  it("badges the state glyphs: the closed thread's octicon-issue-closed, the pull's octicon-git-pull-request", async () => {
    const { viewerId } = await seedFeedWorld();
    const html = await (await fetchUi("/", { headers: { cookie: await sessionHeader(viewerId) } })).text();
    // The glyphs live in the feed rows' item-leading slot; count them over
    // the feed slice alone (the sidebar's repo rows carry their own
    // pull-request chips, so a whole-document count would double-count).
    const feedSlice = html.slice(
      html.indexOf('id="activity-feed"'),
      html.indexOf('id="dashboard-repo-list"'),
    );
    expect((feedSlice.match(/octicon-issue-closed/g) ?? []).length).toBe(1); // the closed thread, red
    expect((feedSlice.match(/octicon-git-pull-request/g) ?? []).length).toBe(1); // the pull (the merged/WIP collapse needs no PR row here)
    // The three open issue threads keep the open glyph.
    expect((feedSlice.match(/octicon-issue-opened/g) ?? []).length).toBe(3);
  });
});

// --- batch-5: the org-list arm (the dashboard-navbar reduction) ----------------------

describe("the org-list arm (the dashboard-navbar reduction)", () => {
  it("an org-owner doer renders no context switcher, no org-visibility labels, no dashboard tabs", async () => {
    // upstream user/dashboard/navbar.tmpl — the switch_dashboard_context
    // dropdown ranging over .Orgs, the org-visibility labels, and the
    // Issues/Pulls/Milestones dashboard tabs — is the module header's
    // documented non-render (dead links forbidden, §2.4.1). The doer OWNS
    // an org, so the switcher's org list would have a row to show.
    const owner = await seedUser("switchless");
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "feedmxorg", ownerId: owner.id, visibility: "public", now: new Date() });
    await orgs.addMember(org.id, owner.id, { now: new Date() });

    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(owner.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content dashboard feeds"); // the dashboard itself
    expect(html).not.toContain("context-user-switch"); // the switcher dropdown
    expect(html).not.toContain("switch_dashboard_context"); // the switcher header
    expect(html).not.toContain("org-visibility"); // the switcher's label slots
    expect(html).not.toContain("octicon-people"); // the team-switcher glyph
    expect(html).not.toContain('href="/issues"'); // the dashboard Issues tab
    expect(html).not.toContain('href="/pulls"'); // the dashboard Pulls tab
    expect(html).not.toContain("/feedmxorg/dashboard"); // an org dashboard link
  });
});

// --- batch-5: the navbar bell seam over this route ------------------------------------

describe("the navbar bell seam (the per-request count over the dashboard route)", () => {
  it("a recipient of foreign activity wears the visible count; a fresh principal wears the hidden zero", async () => {
    // head_navbar_icons.tmpl:41-48's `.notification_count` — the badge lives
    // in the shell, so the dashboard route's own resolveUiSession read
    // (index.ts) drives it; pages-wave10 pins the identical markup over
    // /notifications only.
    const viewer = await seedUser("belled");
    const foreign = await seedUser("bellringer");
    const repoId = await seedRepoRow(viewer, "bellmx", "public");
    const svc = new IssuesService(env.DB);
    const issue = await svc.createIssue({ repoId, title: "bellmx thread", posterId: viewer.id, now: new Date() });
    await svc.addComment({ issueId: issue.id, posterId: foreign.id, content: "ding", now: new Date() });

    const res = await fetchUi("/", { headers: { cookie: await sessionHeader(viewer.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span class="notification_count">1</span>'); // visible, exact count
    expect(html).not.toContain("notification_count tw-hidden");

    // The fresh principal: the zero renders hidden (NewAvailable's falsy arm).
    const fresh = await seedUser("bellfresh");
    const freshRes = await fetchUi("/", { headers: { cookie: await sessionHeader(fresh.id) } });
    expect(freshRes.status).toBe(200);
    const freshHtml = await freshRes.text();
    expect(freshHtml).toContain('<span class="notification_count tw-hidden">0</span>');
    expect(freshHtml).not.toContain('<span class="notification_count">');
  });
});
