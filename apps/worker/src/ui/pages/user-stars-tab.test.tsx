/**
 * The profile STARS tab module's tests (pages wave-124, the UNMOUNTED
 * `/{username}?tab=stars` module): the loader's visibility arms
 * (profile.go:191-219's stars case — stranger/public-only, self+admin with
 * private), pagination, and the DOM (profile.tmpl's `div.stars` branch over
 * shared/repo/list.tmpl rows — the ShowRepoOwnerOnList owner segment, the
 * star chip, the pager, the range-else empty arm). Real D1 via the vitest
 * plugin (generated migrations in beforeAll); the render runs through
 * hono/jsx renderToString — the render.test.tsx harness — with the loader
 * driven directly (the module has no route yet, the HANDOFF NOTE in the
 * module header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { listReposStarredByUser } from "../../api/services/stars";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, repoSettings, stars, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  StarsRepoListItem,
  UserStarsTabPage,
  loadUserStarsTabData,
  userStarsTabLocale,
  type StarsRepoItem,
} from "./user-stars-tab";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "bob", isAdmin: false };

const ctx: UiContext = {
  viewer: selfViewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let bobId = 0;

/** bob (the profile owner) + carol (the repo owner) + the three carol repos
 *  (alpha public with a description + 7 stars, omega public, priv private);
 *  bob stars all three and carries the maintained num_stars = 3. */
async function seedBaseFixtures(): Promise<void> {
  const bob = await drizzle(env.DB)
    .insert(users)
    .values({ username: "bob", usernameLower: "bob", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning()
    .all();
  const carol = await drizzle(env.DB)
    .insert(users)
    .values({
      username: "carol",
      usernameLower: "carol",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  bobId = bob[0]!.id;

  for (const [id, slug, visibility, numStars] of [
    ["repo-alpha", "alpha", "public", 7],
    ["repo-omega", "omega", "public", 0],
    ["repo-priv", "priv", "private", 0],
  ] as const) {
    await drizzle(env.DB).insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: "carol",
      ownerId: carol[0]!.id,
      slug,
      visibility,
      refsVersion: 1,
      backend: "self-hosted",
      numStars,
      createdAt: new Date("2026-02-03T04:05:06Z"),
      updatedAt: new Date("2026-02-04T04:05:06Z"),
    });
    await drizzle(env.DB).insert(stars).values({ userId: bobId, repoId: id, createdAt: new Date() });
  }
  // bob's own repo (the Repositories tab label's count) + the maintained
  // user counter (the Stars tab label's `{{if .ContextUser.NumStars}}`).
  await drizzle(env.DB).insert(repositories).values({
    id: "repo-bob",
    storageKey: "r_repo-bob",
    ownerNamespace: "bob",
    ownerId: bobId,
    slug: "scratch",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await drizzle(env.DB).update(users).set({ numStars: 3 }).where(eq(users.id, bobId));
  await drizzle(env.DB)
    .insert(repoSettings)
    .values({ repoId: "repo-alpha", description: "Alpha demo repo" });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["stars", "repo_settings", "repositories", "users", "follows"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const selfDoer = () => ({ id: bobId, isAdmin: false });
const anonDoer = () => ({ id: null, isAdmin: false });
const adminDoer = () => ({ id: 999, isAdmin: true });

async function userRow(username: string) {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, username)).get();
  if (row === undefined) throw new Error("user seed failed");
  return row;
}

// --- the loader ---------------------------------------------------------------

describe("loadUserStarsTabData (profile.go:191-219's stars case)", () => {
  it("the self doer sees every starred row (private included) in slug order, with the page's counts", async () => {
    await seedBaseFixtures();
    const data = await loadUserStarsTabData(env.DB, await userRow("bob"), selfDoer(), new URLSearchParams());
    expect(data.repos.map((item) => item.repo.slug)).toEqual(["alpha", "omega", "priv"]);
    expect(data.total).toBe(3);
    expect(data.more).toBe(false);
    // The Repositories tab label: bob's own doer-visible repo.
    expect(data.repoCount).toBe(1);
    // The batched description read rides along.
    const alpha = data.repos.find((item) => item.repo.slug === "alpha");
    expect(alpha?.description).toBe("Alpha demo repo");
    expect(data.repos.find((item) => item.repo.slug === "omega")?.description).toBe("");
    expect(data.followers).toBe(0);
    expect(data.following).toBe(0);
  });

  it("a stranger (anonymous doer) sees public starred rows only — the private star drops out", async () => {
    await seedBaseFixtures();
    const data = await loadUserStarsTabData(env.DB, await userRow("bob"), anonDoer(), new URLSearchParams());
    expect(data.repos.map((item) => item.repo.slug)).toEqual(["alpha", "omega"]);
    expect(data.total).toBe(2); // the FILTERED total — the pager's bound
  });

  it("a site-admin doer sees private starred rows (the seePrivate arm)", async () => {
    await seedBaseFixtures();
    const data = await loadUserStarsTabData(env.DB, await userRow("bob"), adminDoer(), new URLSearchParams());
    expect(data.repos.map((item) => item.repo.slug)).toEqual(["alpha", "omega", "priv"]);
    expect(data.total).toBe(3);
  });

  it("paginates at RepoPagingNum=15 — page 1 full with more=true, page 2 the remainder", async () => {
    await seedBaseFixtures();
    // 13 more public carol repos, starred → 16 visible stars.
    const carol = await drizzle(env.DB)
      .select()
      .from(users)
      .where(eq(users.usernameLower, "carol"))
      .get();
    if (carol === undefined) throw new Error("user seed failed");
    for (let i = 1; i <= 13; i++) {
      const id = `repo-extra-${String(i).padStart(2, "0")}`;
      await drizzle(env.DB).insert(repositories).values({
        id,
        storageKey: `r_${id}`,
        ownerNamespace: "carol",
        ownerId: carol.id,
        slug: `extra-${String(i).padStart(2, "0")}`,
        visibility: "public",
        refsVersion: 1,
        backend: "self-hosted",
        createdAt: new Date("2026-02-03T04:05:06Z"),
      });
      await drizzle(env.DB).insert(stars).values({ userId: bobId, repoId: id, createdAt: new Date() });
    }

    const page1 = await loadUserStarsTabData(env.DB, await userRow("bob"), selfDoer(), new URLSearchParams());
    expect(page1.repos).toHaveLength(15);
    expect(page1.total).toBe(16);
    expect(page1.more).toBe(true);

    const page2 = await loadUserStarsTabData(
      env.DB,
      await userRow("bob"),
      selfDoer(),
      new URLSearchParams("page=2"),
    );
    expect(page2.repos).toHaveLength(1);
    expect(page2.repos[0]?.repo.slug).toBe("priv"); // slug ASC: alpha + extras + omega crowd page 1
    expect(page2.more).toBe(false);
  });
});

// --- the DOM -------------------------------------------------------------------

describe("the stars tab DOM (profile.tmpl's `tab == \"stars\"` branch)", () => {
  it("renders the div.stars repo rows with the ShowRepoOwnerOnList owner segment, the star chip, and the tab strip", async () => {
    await seedBaseFixtures();
    const data = await loadUserStarsTabData(env.DB, await userRow("bob"), selfDoer(), new URLSearchParams());
    const html = renderToString(<UserStarsTabPage ctx={ctx} data={data} />);

    // The §2.4.1 discriminator + profile.tmpl's stars branch wrapper.
    expect(html).toContain("user profile");
    expect(html).toContain('<div class="stars">');
    // shared/repo/list.tmpl's wrapper.
    expect(html).toContain('class="flex-divided-list items-with-main"');
    // The owner segment (list.tmpl:9-12): owner link/slug link.
    expect(html).toContain('href="/carol">carol</a>/<a class="tw-text-primary name" href="/carol/alpha">alpha</a>');
    // The star chip ({{if not $.DisableStars}} — default false): live
    // /stars page, the maintained counter.
    expect(html).toContain('href="/carol/alpha/stars"');
    expect(html).toContain('aria-label="Stars"');
    expect(html).toContain("octicon-star");
    expect(html).toContain(">7</span>");
    // The open-pulls chip (the landed row reduction).
    expect(html).toContain('href="/carol/alpha/pulls"');
    // The description row.
    expect(html).toContain("Alpha demo repo");
    // TimeSince (list.tmpl's Updated line).
    expect(html).toContain("<relative-time");
    // The private star's badge (self view).
    expect(html).toContain('ui basic label">Private</span>');

    // The tab strip: Stars ACTIVE (after Activity), the maintained
    // users.num_stars label, the doer-visible Repositories count.
    expect(html).toContain('href="/bob?tab=repositories"');
    expect(html).toContain('href="/bob?tab=activity"');
    expect(html).toContain('<a class="active item" href="/bob?tab=stars">');
    expect(html).toContain(userStarsTabLocale.starred);
    expect(html).toContain('<div class="ui small label">3</div>'); // stars count
    expect(html).toContain('<div class="ui small label">1</div>'); // repo count
    // No pager on a single page (OrgHomePagination reduction posture).
    expect(html).not.toContain("navigation_label");
  });

  it("renders the list's range-else arm on zero visible stars (search.no_results) and no rows", async () => {
    await seedBaseFixtures();
    await env.DB.prepare("DELETE FROM stars").run();
    const data = await loadUserStarsTabData(env.DB, await userRow("bob"), anonDoer(), new URLSearchParams());
    expect(data.repos).toHaveLength(0);
    const html = renderToString(<UserStarsTabPage ctx={ctx} data={data} />);
    expect(html).toContain(userStarsTabLocale.no_results);
    expect(html).not.toContain('href="/carol/alpha/stars"'); // no row chips
  });

  it("renders the row component's arms directly — the internal badge is the ROW owner's visibility", async () => {
    // A public repo under a private-visibility owner (the internal arm) with
    // counters set; the row is built from the SERVICE loader's item (a real
    // repositories row — no hand-maintained fixture).
    const carol = await drizzle(env.DB)
      .insert(users)
      .values({
        username: "carol",
        usernameLower: "carol",
        visibility: "private",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning()
      .all();
    await drizzle(env.DB).insert(repositories).values({
      id: "repo-x",
      storageKey: "r_repo-x",
      ownerNamespace: "carol",
      ownerId: carol[0]!.id,
      slug: "pub",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      numPulls: 3,
      numClosedPulls: 1,
      numStars: 2,
      createdAt: new Date("2026-02-03T04:05:06Z"),
      updatedAt: new Date("2026-02-04T04:05:06Z"),
    });
    await drizzle(env.DB).insert(stars).values({ userId: carol[0]!.id, repoId: "repo-x", createdAt: new Date() });
    const listing = await listReposStarredByUser(env.DB, carol[0]!.id, {
      seePrivate: true,
      page: 1,
      pageSize: 15,
    });
    expect(listing.items).toHaveLength(1);
    // The direct render item is the loader's own shape (a real repositories
    // row — no hand-maintained fixture).
    const item: StarsRepoItem = { ...listing.items[0]!, description: "" };
    const html = renderToString(<StarsRepoListItem item={item} />);
    expect(html).toContain('href="/carol">carol</a>/<a class="tw-text-primary name" href="/carol/pub">pub</a>');
    expect(html).toContain('ui basic label">Internal</span>'); // public repo, private owner
    expect(html).toContain(">2</span>"); // the star chip count
    expect(html).toContain(">2</span></a>"); // open pulls 3-1
  });

  it("the pager carries tab=stars in both directions when the list overflows", async () => {
    await seedBaseFixtures();
    const carol = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "carol")).get();
    if (carol === undefined) throw new Error("user seed failed");
    for (let i = 1; i <= 13; i++) {
      const id = `repo-extra-${String(i).padStart(2, "0")}`;
      await drizzle(env.DB).insert(repositories).values({
        id,
        storageKey: `r_${id}`,
        ownerNamespace: "carol",
        ownerId: carol.id,
        slug: `extra-${String(i).padStart(2, "0")}`,
        visibility: "public",
        refsVersion: 1,
        backend: "self-hosted",
        createdAt: new Date("2026-02-03T04:05:06Z"),
      });
      await drizzle(env.DB).insert(stars).values({ userId: bobId, repoId: id, createdAt: new Date() });
    }

    const page1 = await loadUserStarsTabData(env.DB, await userRow("bob"), selfDoer(), new URLSearchParams());
    const html1 = renderToString(<UserStarsTabPage ctx={ctx} data={page1} />);
    expect(html1).toContain('href="/bob?tab=stars&amp;page=2"');
    expect(html1).toContain(userStarsTabLocale.older);

    const page2 = await loadUserStarsTabData(
      env.DB,
      await userRow("bob"),
      selfDoer(),
      new URLSearchParams("page=2"),
    );
    const html2 = renderToString(<UserStarsTabPage ctx={ctx} data={page2} />);
    expect(html2).toContain('href="/bob?tab=stars"'); // Newer back onto page 1
    expect(html2).toContain(userStarsTabLocale.newer);
    expect(html2).not.toContain(userStarsTabLocale.older);
  });
});
