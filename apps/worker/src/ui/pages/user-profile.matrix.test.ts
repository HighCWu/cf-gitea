/**
 * The user profile page's deferred matrix (the module MOUNTED since the
 * early waves — GET /{username} at ui/index.ts, pages/user-profile.tsx, the
 * USER half of the single-segment owner-home family): the route-level arms
 * the wave-7 block (ui/__tests__/pages-wave7.test.ts) left open, driven
 * through the REAL routes on the tags 01fae9e matrix's minted-session
 * pattern —
 *
 *   - the private/limited visibility CONTINUATION: wave 7 pins the ladder's
 *     status codes only; here the followed viewer's PAGE CONTENT is pinned
 *     (the public-only repo WHERE for a non-admin non-self doer, the
 *     `Internal` badge a private owner's public row wears, the LIMITED
 *     owner's private repo staying hidden from a signed-in stranger),
 *   - the org-home vs user-home discrimination (mixed-case resolve, an org
 *     name ignoring ?tab=activity exactly like upstream's org.Home),
 *   - the ?tab=activity arm's rendering: the wave-50 feeds module is
 *     MOUNTED (this window — ownerHomePage dispatches the tab to
 *     loadActivityFeedsData/renderActivityFeedsPage in the user half; the
 *     org half above ignores the query), and the profile's own strip
 *     carries the two live header.tmpl anchors. These arms pinned the
 *     documented inert posture pre-mount and were re-armed with it (the
 *     deliberate-flip rule),
 *   - the renamed-user redirect arms wave 7 lacks: the PRIVATE and LIMITED
 *     targets answering a signed-in doer with the 307 (the coarse
 *     RedirectToUser gate passes any authenticated principal — only the
 *     anonymous viewer folds into the miss), the display-cased location
 *     rewrite, and the multi-param query preservation,
 *   - the plain unknown-name 404 shells (existence never leaks, not even to
 *     a site admin),
 *   - and the owner-home family's claim pin (parse ↔ registration: the
 *     reserved/excluded/suffix refusals, the feed-suffix claims, the
 *     two-segment never-profile shape),
 *   - the webui-parity COUNT arms: the avatar-card follower/following
 *     totals rendered from REAL follows rows (the seeded upgal→uppal public
 *     edge anon-visible on /uppal and /upgal; the contrasting
 *     private-follower edge staying out of anon's total while the site
 *     admin counts it — upstream's count IS the visibility-filtered
 *     listing's count, profile.go:118-138 + models/user/user.go:355-398).
 *
 * Fixture posture: wave 7's idempotent ensure-once seeding (its block owns
 * its own users; this file adds a disjoint `up*` family) with sessions
 * minted PER REQUEST (the tags-wave pattern — the value is never asserted).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { followUser } from "../../api/services/follows";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { starRepo } from "../../api/services/stars";
import { repoWatchers, repositories, userRedirects, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const FIXED_DATE = new Date("2026-01-15T00:00:00Z");

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

/** The real production path: parse → resolveUiSession → the owner-home
 *  handler (org half, then user half) → load → render/redirect, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  if (as === undefined) return fetchUi(path);
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, as)).get();
  if (user === undefined) throw new Error(`fixture user missing: ${as}`);
  return fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}` } });
}

let seeded = false;

/**
 * Seed the disjoint `up*` fixture family (idempotent on the `upgal`
 * sentinel — the wave-7 ensure-once posture). Relations: uppriv FOLLOWS
 * uppal (upstream's verbatim IsFollowing(u.ID, viewer.ID) — the target
 * follows the viewer), uporg is uppal's org, and the three rename pairs
 * point at public/private/limited targets.
 */
async function ensureFixtures(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);
  const service = new RepoService(env.DB);

  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "upgal")).get()) !== undefined) return;

  // The public profile owner with one public + one private repo.
  await db.insert(users).values({
    username: "upgal",
    usernameLower: "upgal",
    status: "active",
    visibility: "public",
    fullName: "Up Gal",
    createdAt: FIXED_DATE,
  });
  const gal = (await db.select().from(users).where(eq(users.usernameLower, "upgal")).get())!;
  const open = await service.create({ owner: { id: gal.id, usernameLower: "upgal" }, name: "upopen", isPrivate: false, status: "ready" });
  await saveRepoSettings(env.DB, open.id, { description: "The open one." }, FIXED_DATE);
  await service.create({ owner: { id: gal.id, usernameLower: "upgal" }, name: "uphidden", isPrivate: true, status: "ready" });

  // The plain viewers: uppal (followed by the private owner) and upadmin.
  for (const name of ["uppal", "upadmin"]) {
    await db.insert(users).values({
      username: name,
      usernameLower: name,
      status: "active",
      visibility: "public",
      isAdmin: name === "upadmin",
      createdAt: FIXED_DATE,
    });
  }

  // The private profile owner + her follower relation + repos.
  await db.insert(users).values({
    username: "uppriv",
    usernameLower: "uppriv",
    status: "active",
    visibility: "private",
    createdAt: FIXED_DATE,
  });
  const priv = (await db.select().from(users).where(eq(users.usernameLower, "uppriv")).get())!;
  const pal = (await db.select().from(users).where(eq(users.usernameLower, "uppal")).get())!;
  await followUser(env.DB, priv.id, pal.id); // uppriv follows uppal
  // The PUBLIC follow edge (the webui-parity count arm): upgal follows
  // uppal — an ANON-visible followers count on /uppal (both rows public, so
  // the visibility-filtered total shows it — profile.go:118-129's
  // GetUserFollowers renders its FindAndCount into .NumFollowers) and the
  // mirror following count on /upgal; the uppriv edge above is the
  // contrasting PRIVATE-follower arm (invisible to anon's counts).
  await followUser(env.DB, gal.id, pal.id);
  await service.create({ owner: { id: priv.id, usernameLower: "uppriv" }, name: "upexposed", isPrivate: false, status: "ready" });
  await service.create({ owner: { id: priv.id, usernameLower: "uppriv" }, name: "upstash", isPrivate: true, status: "ready" });

  // The limited profile owner with one private repo.
  await db.insert(users).values({
    username: "upshy",
    usernameLower: "upshy",
    status: "active",
    visibility: "limited",
    createdAt: FIXED_DATE,
  });
  const shy = (await db.select().from(users).where(eq(users.usernameLower, "upshy")).get())!;
  await service.create({ owner: { id: shy.id, usernameLower: "upshy" }, name: "upshysecret", isPrivate: true, status: "ready" });

  // The paging profile: 16 public repos (one page of 15 + one row).
  await db.insert(users).values({
    username: "upbulk",
    usernameLower: "upbulk",
    status: "active",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  const bulk = (await db.select().from(users).where(eq(users.usernameLower, "upbulk")).get())!;
  for (let i = 0; i < 16; i++) {
    await service.create({ owner: { id: bulk.id, usernameLower: "upbulk" }, name: `upbulk-${String(i).padStart(2, "0")}`, isPrivate: false, status: "ready" });
  }

  // The stars-tab relation (profile.go:191-219's SearchRepository seed):
  // upgal stars uppriv's PUBLIC repo — a row whose per-row Internal badge
  // differs from the page owner's own visibility. starRepo (not a raw
  // insert) so the maintained users.num_stars label column moves too
  // (migration 0031 — header.tmpl's `{{if .ContextUser.NumStars}}` gate).
  const exposed = (await db.select().from(repositories).where(eq(repositories.slug, "upexposed")).get())!;
  await starRepo(env.DB, gal.id, exposed.id, FIXED_DATE);
  // The watching-tab relation (profile.go:220-246's seed): uppal watches
  // upgal's open repo.
  await db.insert(repoWatchers).values({ repoId: open.id, userId: pal.id, createdAt: FIXED_DATE });

  // The rename pairs: display-cased targets over lower-cased old names.
  for (const [oldName, newName, visibility] of [
    ["upold", "UpNew", "public"],
    ["upoldpriv", "UpNewPriv", "private"],
    ["upoldlim", "UpNewLim", "limited"],
  ] as const) {
    await db.insert(users).values({
      username: newName,
      usernameLower: newName.toLowerCase(),
      status: "active",
      visibility,
      createdAt: FIXED_DATE,
    });
    const target = (await db.select().from(users).where(eq(users.usernameLower, newName.toLowerCase())).get())!;
    await db.insert(userRedirects).values({ lowerName: oldName, redirectUserId: target.id });
  }

  // The org (the tab-discrimination arm — public, so any viewer resolves it).
  if ((await orgs.getOrgByUsername("uporg")) === null) {
    await orgs.createOrg({ name: "uporg", ownerId: pal.id, visibility: "public", now: FIXED_DATE });
  }
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the private/limited profile page CONTENT (beyond wave 7's status ladder) --

describe("the private profile's signed-in rendering (the arms beyond wave 7)", () => {
  it("an anonymous viewer 404-shells; the followed viewer renders the profile with the Private badge", async () => {
    const anon = await get("/uppriv");
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("Page Not Found"); // existence hidden

    const followed = await get("/uppriv", "uppal");
    expect(followed.status).toBe(200);
    const html = await followed.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain('>uppriv<span class="ui large basic horizontal label">Private</span></span>'); // the badge inside the name span
    expect(html).toContain(">Private</span>"); // the avatar-card badge
  });

  it("the followed viewer sees only the PUBLIC rows; the public row wears the Internal badge (private owner)", async () => {
    const followed = await get("/uppriv", "uppal");
    const html = await followed.text();
    expect(html).toContain('href="/uppriv/upexposed"');
    expect(html).not.toContain("/uppriv/upstash"); // the private row never leaks
    expect(html).toContain('<span class="ui basic label">Internal</span>'); // public under a private owner
    expect(html).toContain('<div class="ui small label">1</div>'); // the visible count
  });

  it("the owner and a site admin see both rows (the public one Internal, the private one Private)", async () => {
    for (const viewer of ["uppriv", "upadmin"]) {
      const res = await get("/uppriv", viewer);
      expect(res.status, viewer).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/uppriv/upexposed"');
      expect(html).toContain('href="/uppriv/upstash"');
      expect(html).toContain('<span class="ui basic label">Internal</span>');
      expect(html).toContain('<span class="ui basic label">Private</span>'); // the row badge
      expect(html).toContain('<div class="ui small label">2</div>');
    }
  });

  it("a LIMITED owner's private repo stays hidden from a signed-in stranger (seePrivate is admin/self only)", async () => {
    const res = await get("/upshy", "uppal");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">Limited</span>"); // the avatar-card badge
    expect(html).not.toContain("/upshy/upshysecret"); // the private row never leaks
    expect(html).not.toContain("ui small label"); // zero visible repos → no count label
  });
});

// --- the org home vs user home discrimination ---------------------------------

describe("the org home vs user home discrimination at the shared route", () => {
  it("a mixed-case name resolves to the same user profile (usernameLower), never the org page", async () => {
    const res = await get("/UPGAL");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain(">upgal</span>"); // the STORED display-cased name
    expect(html).not.toContain("page-content organization");
  });

  it("an org name with ?tab=activity still serves the ORG home (org.Home ignores the tab — upstream parity)", async () => {
    const res = await get("/uporg?tab=activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content organization profile"');
    expect(html).not.toContain("page-content user profile");
  });
});

// --- the ?tab=activity arm (the wave-50 module MOUNTED — the user half dispatches)

describe("the ?tab=activity arm's rendering (the module mounted — the tab dispatches)", () => {
  it("renders the feeds page, not the repositories view (profile.go:162-190's arm)", async () => {
    const res = await get("/upgal?tab=activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain('id="activity-feed"'); // feeds.tmpl's container — the arm's DOM
    expect(html).toContain('class="active item" href="/upgal?tab=activity"'); // the active tab
    expect(html).toContain('href="/upgal?tab=repositories"'); // header.tmpl:12's other live tab
    expect(html).not.toContain('href="/upgal/upopen"'); // the repositories rows never leak
  });

  it("the canonical repositories view keeps its pager tab-free while the strip carries both anchors", async () => {
    const res = await get("/upbulk");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/upbulk?page=2"'); // Older — no tab carried
    expect(html).toContain('class="active item" href="/upbulk?tab=repositories"'); // ACTIVE here
    expect(html).toContain('href="/upbulk?tab=activity"'); // header.tmpl:33's anchor
    const tabbed = await get("/upbulk?tab=activity");
    const tabHtml = await tabbed.text();
    expect(tabHtml).toContain('id="activity-feed"'); // the feeds page
    expect(tabHtml).not.toContain('href="/upbulk?page=2"'); // not the repo pager
  });

  it("the tab never bypasses the visibility ladder or the miss path", async () => {
    const priv = await get("/uppriv?tab=activity");
    expect(priv.status).toBe(404); // anonymous on a private owner — the tab changes nothing
    const nobody = await get("/upnobody?tab=activity");
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toContain("Page Not Found");
  });
});

// --- the profile sub-tab arms (the wave-126 mount — the stars/watching/
// follow-tabs modules dispatch from the user half) ---------------------------

describe("the profile sub-tab arms (the wave-126 mount — stars/watching/follow tabs)", () => {
  it("renders the stars page (profile.go:191-219's arm) with Stars ACTIVE in its own strip", async () => {
    const res = await get("/upgal?tab=stars");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain('<div class="stars">'); // profile.tmpl's stars branch wrapper
    expect(html).toContain('class="active item" href="/upgal?tab=stars"'); // the page's own strip
    expect(html).not.toContain('class="active item" href="/upgal?tab=repositories"');
  });

  it("renders the watching page (the DisableStars {{else}} arm — direct-URL-only by default) with watching ACTIVE", async () => {
    const res = await get("/upgal?tab=watching");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).not.toContain('<div class="stars">'); // profile.tmpl's {{else}} branch — no wrapper
    expect(html).toContain('class="active item" href="/upgal?tab=watching"');
  });

  it("renders the followers/following card listings with NEITHER strip tab active", async () => {
    for (const tab of ["followers", "following"]) {
      const res = await get(`/upgal?tab=${tab}`);
      expect(res.status, tab).toBe(200);
      const html = await res.text();
      expect(html, tab).toContain('class="page-content user profile"');
      // NEITHER sub-tab item is active (upstream renders the overview header
      // with no active item for these two — the collapsed-if rule).
      expect(html, tab).not.toContain('class="active item" href="/upgal?tab=stars"');
      expect(html, tab).not.toContain('class="active item" href="/upgal?tab=watching"');
      expect(html, tab).not.toContain('class="active item" href="/upgal?tab=repositories"');
    }
  });

  it("an org name with any sub-tab query still serves the ORG home (the org half ignores the query)", async () => {
    for (const tab of ["stars", "watching", "followers", "following"]) {
      const res = await get(`/uporg?tab=${tab}`);
      expect(res.status, tab).toBe(200);
      const html = await res.text();
      expect(html, tab).toContain('class="page-content organization profile"');
      expect(html, tab).not.toContain("page-content user profile");
    }
  });
});

// --- the sub-tab visibility ladder (the deferred arms — the dispatch's gate
// ordering: resolveUserProfile runs IsUserVisibleToViewer BEFORE any tab data,
// profile.go:77-80, so every tab inherits the page ladder exactly) ----------

const SUB_TABS = ["stars", "watching", "followers", "following"] as const;

describe("the sub-tab visibility ladder (private/limited owner x stranger/self/admin)", () => {
  it("a LIMITED owner: anonymous 404s every sub-tab; a signed-in stranger renders each (user.go:1515-1519)", async () => {
    for (const tab of SUB_TABS) {
      const anon = await get(`/upshy?tab=${tab}`);
      expect(anon.status, tab).toBe(404); // limited needs ANY signed-in viewer
      expect(await anon.text(), tab).toContain("Page Not Found"); // existence never leaks

      const stranger = await get(`/upshy?tab=${tab}`, "uppal");
      expect(stranger.status, tab).toBe(200);
      expect(await stranger.text(), tab).toContain('class="page-content user profile"');
    }
  });

  it("a PRIVATE owner: anonymous 404s every sub-tab; the followed viewer, self and the site admin render them (user.go:1525-1529)", async () => {
    for (const tab of SUB_TABS) {
      const anon = await get(`/uppriv?tab=${tab}`);
      expect(anon.status, tab).toBe(404); // the follower gate — anonymous fails it
      expect(await anon.text(), tab).toContain("Page Not Found");

      for (const viewer of ["uppal", "uppriv", "upadmin"]) {
        const res = await get(`/uppriv?tab=${tab}`, viewer);
        expect(res.status, `${tab} as ${viewer}`).toBe(200);
        expect(await res.text(), `${tab} as ${viewer}`).toContain('class="page-content user profile"');
      }
    }
  });

  it("each sub-tab renders ITS OWN body DOM — the tab dispatch's per-arm markers", async () => {
    const stars = await get("/uppriv?tab=stars", "uppal");
    const starsHtml = await stars.text();
    expect(starsHtml).toContain('<div class="stars">'); // profile.tmpl's stars branch wrapper
    expect(starsHtml).toContain('class="active item" href="/uppriv?tab=stars"');

    const watching = await get("/uppriv?tab=watching", "uppal");
    const watchingHtml = await watching.text();
    expect(watchingHtml).not.toContain('<div class="stars">'); // the DisableStars {{else}} arm
    expect(watchingHtml).toContain('class="active item" href="/uppriv?tab=watching"');
    expect(watchingHtml).toContain("octicon-eye"); // the watching anchor's glyph

    for (const tab of ["followers", "following"] as const) {
      const res = await get(`/uppriv?tab=${tab}`, "uppal");
      const html = await res.text();
      expect(html, tab).toContain('id="user-cards-container"'); // user_cards.tmpl:2
      expect(html, tab).toContain('data-fetch-trigger="fetch-reload"');
      expect(html, tab).toContain('<ul class="list">');
      // The collapsed-if rule (header.tmpl has no follower anchors): NOTHING
      // in the strip is active on these two tabs.
      expect(html, tab).not.toContain('class="active item" href=');
    }
  });
});

// --- the sub-tab content through the mounted route (the star/watch/follow
// relations seeded above — the arms the per-tab module tests drive through
// their loader seams, now through the REAL route + session) ------------------

describe("the sub-tab content through the route (real relations)", () => {
  it("the stars tab: the starred row carries the owner segment, the PER-ROW Internal badge and the star chip", async () => {
    const res = await get("/upgal?tab=stars");
    expect(res.status).toBe(200);
    const html = await res.text();
    // ShowRepoOwnerOnList (profile.go:194, list.tmpl:9-12) — the JSX text
    // node "/" glues the two anchors with no whitespace.
    expect(html).toContain('<a class="tw-text-primary name" href="/uppriv">uppriv</a>/<a class="tw-text-primary name" href="/uppriv/upexposed">upexposed</a>');
    // The internal badge reads THIS ROW's owner visibility (uppriv is
    // private) — not the page owner's public visibility.
    expect(html).toContain('<span class="ui basic label">Internal</span>');
    expect(html).toContain('href="/uppriv/upexposed/stars"'); // the live stargazers chip
    expect(html).not.toContain('href="/upgal/upopen"'); // the repositories rows never leak onto this tab
  });

  it("the stars tab's range-else arm: zero visible stars = the exact no-results node, no pager (list.tmpl's {{else}})", async () => {
    const res = await get("/uppriv?tab=stars", "uppal");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<div>No matching results found.</div>"); // search.no_results
    expect(html).not.toContain('class="center page buttons"'); // page 1, no more → no pager
  });

  it("the stars strip carries the maintained numStars label (migration 0031) on the repositories page too", async () => {
    const res = await get("/upgal");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/upgal?tab=stars"');
    expect(html).toContain('<div class="ui small label">1</div>'); // the starred-count label
  });

  it("the following tab renders the real card: uppriv follows uppal — DisplayName link and the avatar-card count", async () => {
    const res = await get("/uppriv?tab=following", "uppal");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<li class="item ui segment">'); // user_cards.tmpl:10
    expect(html).toContain('<h3 class="name flex-text-block"><a href="/uppal">uppal</a></h3>'); // :14 (JSX folds the newline)
    expect(html).toContain("Joined on"); // the meta chain's joined-on arm (no website/location on uppal)
    expect(html).toContain('href="/uppriv?tab=following"'); // profile_big_avatar.tmpl:25's live anchor
    expect(html).toContain("1 following</a>"); // the REAL total feeds the card
  });

  it("the followers tab is the mirror direction: /uppal?tab=followers lists uppriv", async () => {
    const res = await get("/uppal?tab=followers", "uppal");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<li class="item ui segment">');
    expect(html).toContain('<a href="/uppriv">uppriv</a>');
    // uppal follows nobody: the following anchor reads 0.
    expect(html).toContain("0 following</a>");
  });

  it("the watching tab: the watched row renders through the route; a non-watcher's tab is the exact empty node", async () => {
    const res = await get("/uppal?tab=watching");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="active item" href="/uppal?tab=watching"');
    expect(html).toContain('href="/upgal/upopen"'); // the watched row (ShowRepoOwnerOnList unset — name only)

    const empty = await get("/uppriv?tab=watching", "uppal");
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("<div>No matching results found.</div>");
  });
});

// --- the avatar-card follow counts (the webui-parity arm — real follows
// rows, anon-visible) --------------------------------------------------------

describe("the avatar-card follow counts (real follows rows, anon-visible)", () => {
  it("counts from the seeded public edge: anon sees /uppal 1 followers and /upgal 1 following", async () => {
    // upstream renders profile_big_avatar.tmpl:25's counts from
    // profile.go:118-138 — GetUserFollowers/GetUserFollowing's FindAndCount
    // totals (models/user/user.go:355-398, the visibility-FILTERED
    // listings — NOT the raw maintained counters) — the landed loader's
    // listFollowers/listFollowing .total is that same query over the
    // follows table. The upgal→uppal edge is all-public, so anonymous sees
    // both counts on the repositories view.
    const followers = await get("/uppal");
    expect(followers.status).toBe(200);
    const followersHtml = await followers.text();
    expect(followersHtml).toContain('href="/uppal?tab=followers"');
    expect(followersHtml).toContain("1 followers</a>");
    const gal = await get("/upgal");
    expect(gal.status).toBe(200);
    const galHtml = await gal.text();
    expect(galHtml).toContain('href="/upgal?tab=following"');
    expect(galHtml).toContain("1 following</a>");
  });

  it("the private follower stays out of anon's count and in the admin's (the filter IS the count)", async () => {
    // The uppriv→uppal edge exists, but uppriv is PRIVATE: anon's followers
    // total counts only the public edge (user.go:1466-1501's
    // isUserVisibleToViewerCond — upstream's count IS the filtered listing's
    // count, never the raw row count), while the site admin's unfiltered
    // view counts both edges.
    const anon = await get("/uppal");
    const anonHtml = await anon.text();
    expect(anonHtml).toContain("1 followers</a>");
    expect(anonHtml).not.toContain("2 followers</a>");
    const admin = await get("/uppal", "upadmin");
    expect(await admin.text()).toContain("2 followers</a>");
  });
});

// --- the repositories pager's boundary pages (the deferred arms — the
// shared parsePageNumber clamp + OrgHomePagination's Older/Newer ternary) ----

describe("the repositories pager's boundary pages", () => {
  it("page 2 of 16: exactly the 16th row, Newer links the BARE profile URL (not ?page=1), no Older", async () => {
    const res = await get("/upbulk?page=2");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/upbulk/upbulk-15"'); // the 16th row alone
    expect(html).not.toContain('href="/upbulk/upbulk-00"'); // page 1's rows gone
    // OrgHomePagination's page>2 ternary: page 2's Newer is the bare link.
    expect(html).toContain('<a class="item navigation" href="/upbulk"><span class="navigation_label">Newer</span></a>');
    expect(html).not.toContain(">Older<");
  });

  it("a page beyond the end: zero rows, Newer back to page 2, no Older", async () => {
    const res = await get("/upbulk?page=3");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('href="/upbulk/upbulk-00"'); // the offset past the total
    expect(html).toContain('<a class="item navigation" href="/upbulk?page=2"><span class="navigation_label">Newer</span></a>');
    expect(html).not.toContain(">Older<"); // more = 3*15 < 16 is false
  });

  it("junk and out-of-range pages fold onto page 1 (parsePageNumber's clamp)", async () => {
    for (const query of ["page=abc", "page=0", "page=-3"]) {
      const res = await get(`/upbulk?${query}`);
      expect(res.status, query).toBe(200);
      const html = await res.text();
      expect(html, query).toContain('href="/upbulk/upbulk-00"'); // the first page's rows
      expect(html, query).not.toContain('href="/upbulk/upbulk-15"');
      expect(html, query).toContain('href="/upbulk?page=2"'); // Older offered again
    }
  });

  it("a zero-repo profile: the empty list wrapper renders unconditionally, no count label, no pager", async () => {
    const res = await get("/uppal");
    expect(res.status).toBe(200);
    const html = await res.text();
    // shared/repo/list.tmpl:1 — the wrapper renders even with zero rows
    // (upstream's own shape; home.tmpl's empty-placeholder is NOT this template).
    expect(html).toContain('<div class="flex-divided-list items-with-main"></div>');
    expect(html).not.toContain("ui small label"); // repoCount 0 AND numStars 0 → both labels gated off
    expect(html).not.toContain('class="center page buttons"'); // page <= 1 && !more → the pager is null
  });
});

// --- renamed users through the shared seam (beyond wave 7's public pair) ------

describe("renamed users through the shared seam (the gated-target arms)", () => {
  it("a PRIVATE target 307s for a signed-in viewer; anonymous folds into the miss", async () => {
    const anon = await get("/upoldpriv");
    expect(anon.status).toBe(404); // "must be signed in to see limited or private" — indistinguishable
    expect(await anon.text()).toContain("Page Not Found");

    const signed = await get("/upoldpriv", "uppal");
    expect(signed.status).toBe(307);
    expect(signed.headers.get("location")).toBe("/UpNewPriv");
  });

  it("a LIMITED target: anonymous 404, any signed-in viewer 307s", async () => {
    const anon = await get("/upoldlim");
    expect(anon.status).toBe(404);

    const signed = await get("/upoldlim", "uppal");
    expect(signed.status).toBe(307);
    expect(signed.headers.get("location")).toBe("/UpNewLim");
  });

  it("the location rewrites to the DISPLAY-cased target and preserves a multi-param query; the new name resolves", async () => {
    const redirect = await get("/upold?tab=activity&x=1");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/UpNew?tab=activity&x=1");

    const target = await get("/UpNew");
    expect(target.status).toBe(200);
    expect(await target.text()).toContain(">UpNew</span>");
  });
});

// --- unknown names ------------------------------------------------------------

describe("unknown names (existence never leaks)", () => {
  it("an unknown name 404-shells identically for anonymous and site admin", async () => {
    for (const viewer of [undefined, "upadmin"]) {
      const res = await get("/upnobody", viewer);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Page Not Found");
    }
  });
});

// --- the ?sudo= parameter is web-UI inert (the sudo seam, wave-matrix-15) ------
//
// The fix wave's sudo() mount (32eaa73) rides app.use("/api/v1/*", ...) — the
// web UI resolves its doer from the session cookie alone (resolveUiSession),
// and no ui route reads the sudo query. These arms pin the no-cross-
// contamination half through the REAL owner-home route: an API-style ?sudo=
// on a web URL never impersonates anyone and never elevates a session.

describe("the ?sudo= parameter is web-UI inert (the API-only mount's seam)", () => {
  it("an anonymous viewer carrying ?sudo=<an admin> still 404-shells the private profile", async () => {
    const res = await get("/uppriv?sudo=upadmin");
    expect(res.status).toBe(404); // sudo bought nothing — the doer stayed anonymous
    expect(await res.text()).toContain("Page Not Found");
  });

  it("a signed-in stranger carrying ?sudo=<the owner> still 404-shells the private profile", async () => {
    // upgal is signed in but unrelated to uppriv (no follow, no shared org).
    const res = await get("/uppriv?sudo=uppriv", "upgal");
    expect(res.status).toBe(404); // naming the OWNER in sudo admits no stranger
    expect(await res.text()).toContain("Page Not Found");
  });

  it("the owner's own session ignores ?sudo=<someone else> — the doer is never swapped", async () => {
    const res = await get("/uppriv?sudo=upgal", "uppriv");
    expect(res.status).toBe(200); // a swapped doer (upgal) would lose self-sight → 404
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain(">uppriv<span"); // the owner's own page rendered
  });

  it("the site admin's session renders without the parameter's help and ignores its target", async () => {
    const res = await get("/uppriv?sudo=uppal", "upadmin");
    expect(res.status).toBe(200); // the admin's OWN session ladder, not the sudo target's
    expect(await res.text()).toContain('class="page-content user profile"');
  });
});

// --- the route claim pin (the owner-home family's parse ↔ registration) -------

describe("the route claim pin (the owner-home family)", () => {
  it("claims exactly the single non-reserved segment; the raw casing survives, encoding decodes", () => {
    expect(parseUiRoute("/upgal")).toEqual({ family: "owner-home", owner: "upgal" });
    expect(handlesUiRoute("/upgal")).toBe(true);
    expect(parseUiRoute("/UPGAL")).toEqual({ family: "owner-home", owner: "UPGAL" }); // resolution folds case
    expect(parseUiRoute("/w%61ve7up")).toEqual({ family: "owner-home", owner: "wave7up" }); // decoded
  });

  it("refuses the top-level literals, the reserved owner names and the .keys/.gpg suffixes (never claimed)", () => {
    for (const path of ["/login", "/logout", "/healthz", "/api", "/assets", "/upgal.keys", "/upgal.gpg"]) {
      expect(parseUiRoute(path), path).toBeNull();
      expect(handlesUiRoute(path), path).toBe(false);
    }
  });

  it("the feed suffixes claim the owner into the window-2e families, not the profile", () => {
    expect(parseUiRoute("/upgal.rss")).toEqual({ family: "user-feed-rss", owner: "upgal" });
    expect(parseUiRoute("/upgal.atom")).toEqual({ family: "user-feed-atom", owner: "upgal" });
  });

  it("a second segment is never the profile (the repo-home family claims /{owner}/{repo})", () => {
    expect(parseUiRoute("/upgal/uprepo")).toEqual({ family: "home", owner: "upgal", repo: "uprepo", refSuffix: null });
    expect(parseUiRoute("/upgal/uprepo/extra")).toBeNull(); // a junk deeper tail stays unclaimed (the engine's 404)
  });
});
