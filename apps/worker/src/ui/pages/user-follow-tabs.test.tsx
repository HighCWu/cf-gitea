/**
 * The profile followers/following tabs module's tests (the UNMOUNTED
 * `/{username}?tab=followers|following` pages — pages/user-follow-tabs.tsx):
 * the loader's service-parameter contract (profile.go:121-161's arms — both
 * listings at the same page/pageSize, the doer passthrough, the paging
 * clamp) and the user_cards.tmpl DOM over each card's meta arm, the pager's
 * tab-carrying links and the empty state. Real D1 via the vitest plugin
 * (generated migrations in beforeAll); the render runs through hono/jsx
 * renderToString — the activity-feeds.test.tsx harness — with the loader
 * driven directly (the module has no route arm yet, the HANDOFF NOTE in the
 * module header: the route-level dispatch arms ride the wiring window's
 * own matrix, user-profile.matrix.test.ts's pattern).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { followUser } from "../../api/services/follows";
import { repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import {
  FollowCard,
  FollowCardsList,
  UserFollowTabsPage,
  loadUserFollowTabsData,
  parseFollowTab,
  type FollowTab,
  type UserFollowTabsData,
} from "./user-follow-tabs";
import type { ProfileDoer, UserProfileRow } from "./user-profile";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const FIXED_DATE = new Date("2026-01-15T00:00:00Z"); // → "Joined on Jan 15, 2026"

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const ctx: UiContext = {
  viewer: { kind: "user", id: 1, username: "gal", isAdmin: false },
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

const anon: ProfileDoer = { id: null, isAdmin: false };
const admin: ProfileDoer = { id: 90, isAdmin: true };

/** The named fixture row (rows are seeded by lower-cased name). */
async function userRow(name: string): Promise<UserProfileRow> {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, name)).get();
  if (row === undefined) throw new Error(`fixture user missing: ${name}`);
  return row;
}

/**
 * The base relation set: gal's followers are pal (public, website),
 * priv (PRIVATE), lim (limited) and quiet (public, no website/location —
 * the joined-on arm); gal follows pal, priv AND the org row uporg (the
 * following list legitimately carries organizations, the followers list
 * never does). stranger holds no relations (the signed-in-outsider
 * visibility arm).
 */
async function seedBaseFixtures(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(users).values({
    username: "gal",
    usernameLower: "gal",
    fullName: "Gal Owner",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  for (const [name, fullName, visibility, website, location] of [
    ["pal", "Pal Follower", "public", "https://pal.example", null],
    ["priv", "Priv Follower", "private", null, null],
    ["lim", "Lim Follower", "limited", null, null],
    ["quiet", "Quiet Follower", "public", null, null],
    ["stranger", null, "public", null, null],
  ] as const) {
    await db.insert(users).values({
      username: name,
      usernameLower: name,
      fullName,
      visibility,
      website,
      location,
      createdAt: FIXED_DATE,
    });
  }
  await db.insert(users).values({
    username: "uporg",
    usernameLower: "uporg",
    fullName: "Up Org",
    type: "org",
    visibility: "public",
    createdAt: FIXED_DATE,
  });

  const gal = await userRow("gal");
  for (const name of ["pal", "priv", "lim", "quiet"]) {
    await followUser(env.DB, (await userRow(name)).id, gal.id); // <name> follows gal
  }
  for (const name of ["pal", "priv", "uporg"]) {
    await followUser(env.DB, gal.id, (await userRow(name)).id); // gal follows <name>
  }

  // One public + one private repo for the header count's doer-visible WHERE.
  await db.insert(repositories).values({
    id: "repo-follow-public",
    storageKey: "repo-follow-public",
    ownerNamespace: "gal",
    ownerId: gal.id,
    slug: "open",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  await db.insert(repositories).values({
    id: "repo-follow-private",
    storageKey: "repo-follow-private",
    ownerNamespace: "gal",
    ownerId: gal.id,
    slug: "stash",
    visibility: "private",
    createdAt: FIXED_DATE,
  });
}

/** 16 public followers for the paging owner (one page of 15 + one row). */
async function seedPagingFixtures(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(users).values({
    username: "bulk",
    usernameLower: "bulk",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  const bulk = await userRow("bulk");
  for (let i = 0; i < 16; i++) {
    const name = `bulkf${String(i).padStart(2, "0")}`;
    await db.insert(users).values({ username: name, usernameLower: name, visibility: "public", createdAt: FIXED_DATE });
    await followUser(env.DB, (await userRow(name)).id, bulk.id);
  }
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["follows", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the tab parse ------------------------------------------------------------

describe("parseFollowTab (the ownerHomePage dispatch's literal pair)", () => {
  it("following → the following projection; everything else falls back to followers", () => {
    expect(parseFollowTab("following")).toBe<FollowTab>("following");
    expect(parseFollowTab("followers")).toBe<FollowTab>("followers");
    expect(parseFollowTab(null)).toBe<FollowTab>("followers");
    expect(parseFollowTab("repositories")).toBe<FollowTab>("followers"); // unreachable from the route
  });
});

// --- the loader (profile.go:121-161's arms over the landed service) ------------

describe("loadUserFollowTabsData (the loader seam)", () => {
  it("the followers tab: individual followers only, the service's visibility filter through the anonymous doer", async () => {
    await seedBaseFixtures();
    const data = await loadUserFollowTabsData(env.DB, await userRow("gal"), anon, new URLSearchParams());

    expect(data.tab).toBe("followers");
    // anonymous ⇒ public rows only (followVisibilityCond): priv AND lim stay
    // hidden — pal + quiet, id order (insert order).
    expect(data.cards.map((card) => card.username)).toEqual(["pal", "quiet"]);
    // The avatar card's counts are the viewer-dependent TOTALS (upstream's
    // FindAndCount under the same cond) — BOTH listings always ran.
    expect(data.followers).toBe(2);
    expect(data.following).toBe(2); // pal + uporg; priv is private
    expect(data.page).toBe(1);
    expect(data.more).toBe(false);
  });

  it("a signed-in outsider sees limited rows too; self and admin see every follower", async () => {
    await seedBaseFixtures();
    const outsider = await loadUserFollowTabsData(
      env.DB,
      await userRow("gal"),
      { id: (await userRow("stranger")).id, isAdmin: false },
      new URLSearchParams(),
    );
    expect(outsider.cards.map((card) => card.username)).toEqual(["pal", "lim", "quiet"]); // priv still hidden, id order

    const self = await loadUserFollowTabsData(
      env.DB,
      await userRow("gal"),
      { id: (await userRow("gal")).id, isAdmin: false },
      new URLSearchParams(),
    );
    // Self-view: priv follows gal ⇒ the followers-of-viewer arm shows her.
    expect(self.cards.map((card) => card.username)).toEqual(["pal", "priv", "lim", "quiet"]);
    expect(self.followers).toBe(4);
    expect(self.following).toBe(3); // gal follows pal + priv + uporg, all visible to herself

    const adminData = await loadUserFollowTabsData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    expect(adminData.cards.map((card) => card.username)).toEqual(["pal", "priv", "lim", "quiet"]);
    expect(adminData.followers).toBe(4);
  });

  it("the following tab: organizations legitimately appear — and never in the followers list", async () => {
    await seedBaseFixtures();
    const params = new URLSearchParams("tab=following");
    const data = await loadUserFollowTabsData(env.DB, await userRow("gal"), admin, params);
    expect(data.tab).toBe("following");
    expect(data.cards.map((card) => card.username)).toEqual(["pal", "priv", "uporg"]);
    // The mirror side stays the followers listing (orgs filtered by type).
    const mirror = await loadUserFollowTabsData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    expect(mirror.cards.map((card) => card.username)).not.toContain("uporg");
  });

  it("paging: RepoPagingNum=15 per page, the more flag, and the clamp (page ≤ 0/junk → 1)", async () => {
    await seedPagingFixtures();
    const bulk = await userRow("bulk");

    const page1 = await loadUserFollowTabsData(env.DB, bulk, admin, new URLSearchParams());
    expect(page1.cards).toHaveLength(15);
    expect(page1.followers).toBe(16);
    expect(page1.more).toBe(true);

    const page2 = await loadUserFollowTabsData(env.DB, bulk, admin, new URLSearchParams("page=2"));
    expect(page2.cards).toHaveLength(1);
    expect(page2.more).toBe(false);
    expect(page2.page).toBe(2);

    for (const junk of ["0", "-3", "page", "1.5"]) {
      const clamped = await loadUserFollowTabsData(env.DB, bulk, admin, new URLSearchParams(`page=${junk}`));
      expect(clamped.page, junk).toBe(1);
      expect(clamped.cards, junk).toHaveLength(15);
    }

    // The INACTIVE listing paged at the same page still counts the whole
    // side (both listings run — profile.go:121-138).
    expect(page1.following).toBe(0);
  });

  it("the Repositories header count rides the doer-visible WHERE (admin/self see private rows)", async () => {
    await seedBaseFixtures();
    const strangerData = await loadUserFollowTabsData(
      env.DB,
      await userRow("gal"),
      { id: (await userRow("stranger")).id, isAdmin: false },
      new URLSearchParams(),
    );
    expect(strangerData.repoCount).toBe(1); // the public row only

    const adminData = await loadUserFollowTabsData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    expect(adminData.repoCount).toBe(2);
  });
});

// --- the render (user_cards.tmpl's DOM) -----------------------------------------

describe("FollowCard (user_cards.tmpl:10-25's row)", () => {
  it("the name link carries DisplayName (fullName → username fallback) and the meta arms chain", async () => {
    await seedBaseFixtures();
    const pal = await userRow("pal");
    const palHtml = renderToString(<FollowCard user={pal} />);
    expect(palHtml).toContain('<li class="item ui segment">');
    expect(palHtml).toContain('<h3 class="name flex-text-block"><a href="/pal">Pal Follower</a></h3>');
    expect(palHtml).toContain("octicon-person"); // the avatar placeholder (the anchor dropped)
    expect(palHtml).toContain('octicon-link'); // the website arm
    expect(palHtml).toContain('<a href="https://pal.example" target="_blank">https://pal.example</a>');
    expect(palHtml).not.toContain("octicon-location");

    const gal = await userRow("gal"); // no website, no location → the joined-on arm
    const galHtml = renderToString(<FollowCard user={gal} />);
    expect(galHtml).toContain("octicon-calendar");
    expect(galHtml).toContain("Joined on Jan 15, 2026");
  });

  it("the location arm renders between website and joined-on", async () => {
    await seedBaseFixtures();
    const db = drizzle(env.DB);
    await db.update(users).set({ location: "The Moon" }).where(eq(users.usernameLower, "quiet"));
    const quiet = await userRow("quiet");
    const html = renderToString(<FollowCard user={quiet} />);
    expect(html).toContain("octicon-location");
    expect(html).toContain("The Moon");
    expect(html).not.toContain("Joined on");
  });
});

describe("FollowCardsList (the container + the tab-carrying pager)", () => {
  const base = {
    username: "gal",
    cards: [] as UserProfileRow[],
    page: 1,
    more: false,
  };

  it("the container renders verbatim; an empty list is upstream's own empty state with no pager", () => {
    const html = renderToString(
      <FollowCardsList username="gal" tab="followers" cards={[]} page={1} more={false} />,
    );
    expect(html).toContain('class="user-cards" id="user-cards-container" data-fetch-trigger="fetch-reload"');
    expect(html).toContain('<ul class="list"></ul>');
    expect(html).not.toContain("center page buttons"); // single page ⇒ no pager
    expect(html).not.toContain("ui dividing header"); // CardsTitle is never set by profile.go
  });

  it("the pager keeps the tab on every link; page 1 is the bare ?tab= URL", async () => {
    await seedPagingFixtures();
    const data: UserFollowTabsData = await loadUserFollowTabsData(
      env.DB,
      await userRow("bulk"),
      admin,
      new URLSearchParams(),
    );
    const html = renderToString(
      <FollowCardsList username="bulk" tab={data.tab} cards={data.cards} page={data.page} more={data.more} />,
    );
    expect(html).toContain('<span class="navigation_label">Older</span>');
    expect(html).toContain('href="/bulk?tab=followers&amp;page=2"'); // renderToString escapes the &amp;
    expect(html).not.toContain("Newer"); // page 1 has no Newer link

    const page2 = await loadUserFollowTabsData(env.DB, await userRow("bulk"), admin, new URLSearchParams("page=2"));
    const tail = renderToString(
      <FollowCardsList username="bulk" tab={page2.tab} cards={page2.cards} page={page2.page} more={page2.more} />,
    );
    expect(tail).toContain('<span class="navigation_label">Newer</span>');
    expect(tail).toContain('href="/bulk?tab=followers"'); // page 1 without a page param
    expect(tail).not.toContain("Older");

    // The following projection's pager carries tab=following.
    const followingPager = renderToString(
      <FollowCardsList username="gal" tab="following" cards={base.cards} page={2} more={true} />,
    );
    expect(followingPager).toContain('href="/gal?tab=following&amp;page=3"');
    expect(followingPager).toContain('href="/gal?tab=following"');
  });
});

// --- the full document (profile.tmpl's grid, the follow-tabs branch) ------------

describe("UserFollowTabsPage (the full-document render)", () => {
  it("renders the profile grid with the avatar card's REAL counts, the inactive strip and the cards", async () => {
    await seedBaseFixtures();
    const data = await loadUserFollowTabsData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    const html = renderToString(<UserFollowTabsPage ctx={ctx} data={data} />);

    expect(html).toContain('class="page-content user profile"'); // profile.tmpl:2's discriminator
    expect(html).toContain('id="profile-avatar-card"'); // the four-wide column's card
    expect(html).toContain(">4 followers</span>"); // the REAL totals (profile_big_avatar.tmpl:25)
    expect(html).toContain(">3 following</span>");
    // The strip: both live tabs present, NEITHER active (header.tmpl's two
    // eq .TabName conditions fail for followers/following).
    expect(html).toContain('class="item" href="/gal?tab=repositories"');
    expect(html).toContain('class="item" href="/gal?tab=activity"');
    expect(html).toContain('<div class="ui small label">2</div>'); // admin sees both repos
    expect(html).not.toContain('class="active item" href="/gal?tab=repositories"');
    expect(html).not.toContain('class="active item" href="/gal?tab=activity"');
    // The cards + their container.
    expect(html).toContain('id="user-cards-container"');
    expect(html).toContain('<a href="/pal">Pal Follower</a>');
    expect(html).toContain('<a href="/priv">Priv Follower</a>'); // admin sees every follower
  });

  it("the visibility filter shows through the full render (anonymous vs admin)", async () => {
    await seedBaseFixtures();
    const anonData = await loadUserFollowTabsData(env.DB, await userRow("gal"), anon, new URLSearchParams());
    const anonHtml = renderToString(<UserFollowTabsPage ctx={ctx} data={anonData} />);
    expect(anonHtml).toContain(">2 followers</span>");
    expect(anonHtml).toContain('<a href="/pal">Pal Follower</a>');
    expect(anonHtml).not.toContain(">Priv Follower</a>");
    expect(anonHtml).toContain('<div class="ui small label">1</div>'); // the public repo only

    const adminData = await loadUserFollowTabsData(env.DB, await userRow("gal"), admin, new URLSearchParams("tab=following"));
    const adminHtml = renderToString(<UserFollowTabsPage ctx={ctx} data={adminData} />);
    expect(adminHtml).toContain("<title>Gal Owner - ");
    expect(adminHtml).toContain('<a href="/uporg">Up Org</a>'); // the org card
    expect(adminHtml).toContain('<a href="/priv">Priv Follower</a>');
  });
});
