/**
 * The profile WATCHING tab module's tests (the UNMOUNTED
 * `/{username}?tab=watching` page — pages/user-watching-tab.tsx): the
 * loader's lister contract (profile.go:220-246's arm over the landed
 * listWatchedRepositories — the reduced-ACL visibility arms incl. the
 * owned-by-doer arm the stranger resolves, the paging clamp, the
 * Repositories count's doer-visible WHERE) and the shared/repo/list.tmpl
 * DOM over the watching arm's gates (name-only title, per-row internal
 * badge, the star+pulls chips), the tab-carrying pager and the empty state.
 * Real D1 via the vitest plugin (generated migrations in beforeAll); the
 * render runs through hono/jsx renderToString — the user-follow-tabs.test
 * harness — with the loader driven directly (the module has no route arm
 * yet, the HANDOFF NOTE in the module header: the route-level dispatch arm
 * rides the wiring window's own matrix, user-profile.matrix.test.ts's
 * pattern).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { followUser } from "../../api/services/follows";
import { repoSettings, repoWatchers, repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import {
  EyeIcon,
  UserWatchingTabPage,
  WatchingRepoListItem,
  loadUserWatchingTabData,
  type WatchingRepoItem,
} from "./user-watching-tab";
import type { ProfileDoer, UserProfileRow } from "./user-profile";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const FIXED_DATE = new Date("2026-01-15T00:00:00Z");

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

interface RepoSpec {
  /** Numeric TEXT ids exercise the landed lister's `CAST(id AS INTEGER)`
   *  ordering meaningfully (non-numeric ids all cast to 0). */
  id: string;
  owner: string;
  slug: string;
  visibility: "public" | "private";
  description?: string;
  numStars?: number;
  numPulls?: number;
  numClosedPulls?: number;
}

/**
 * The watch graph: gal watches six repos spread over four owners — her own
 * public `open` + private `secret`, ally's public `openally` + private
 * `stash`, hid's public `pubrow` (a PUBLIC repo under a PRIVATE owner —
 * the internal-badge arm) and stranger's private `den`. Ids ascend in the
 * array order = the landed lister's numeric order.
 */
const GAL_REPOS: RepoSpec[] = [
  {
    id: "1001",
    owner: "gal",
    slug: "open",
    visibility: "public",
    description: "her open repo",
    numStars: 3,
    numPulls: 5,
    numClosedPulls: 2,
  },
  { id: "1002", owner: "gal", slug: "secret", visibility: "private" },
  { id: "1003", owner: "ally", slug: "openally", visibility: "public" },
  { id: "1004", owner: "ally", slug: "stash", visibility: "private" },
  { id: "1005", owner: "hid", slug: "pubrow", visibility: "public" },
  { id: "1006", owner: "stranger", slug: "den", visibility: "private" },
];

async function seedRepo(spec: RepoSpec): Promise<void> {
  const owner = await userRow(spec.owner);
  await drizzle(env.DB).insert(repositories).values({
    id: spec.id,
    storageKey: spec.id,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug: spec.slug,
    visibility: spec.visibility,
    numStars: spec.numStars ?? 0,
    numPulls: spec.numPulls ?? 0,
    numClosedPulls: spec.numClosedPulls ?? 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  });
  if (spec.description !== undefined) {
    await drizzle(env.DB).insert(repoSettings).values({ repoId: spec.id, description: spec.description });
  }
}

async function seedBaseFixtures(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(users).values({
    username: "gal",
    usernameLower: "gal",
    fullName: "Gal Owner",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  for (const [name, visibility] of [
    ["ally", "public"],
    ["hid", "private"],
    ["stranger", "public"],
  ] as const) {
    await db.insert(users).values({
      username: name,
      usernameLower: name,
      visibility,
      createdAt: FIXED_DATE,
    });
  }
  for (const spec of GAL_REPOS) await seedRepo(spec);
  for (const spec of GAL_REPOS) {
    await db.insert(repoWatchers).values({ repoId: spec.id, userId: (await userRow("gal")).id });
  }
  // One follower so the avatar card's count is real.
  await followUser(env.DB, (await userRow("ally")).id, (await userRow("gal")).id);
}

/** 16 PUBLIC watched repos for the paging owner (one page of 15 + one row). */
async function seedPagingFixtures(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(users).values({
    username: "bulk",
    usernameLower: "bulk",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  for (let i = 0; i < 16; i++) {
    const id = String(2000 + i);
    await seedRepo({ id, owner: "bulk", slug: `bulk${String(i).padStart(2, "0")}`, visibility: "public" });
    await db.insert(repoWatchers).values({ repoId: id, userId: (await userRow("bulk")).id });
  }
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_watchers", "follows", "repo_settings", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader (profile.go:220-246's arm over the landed lister) --------------

describe("loadUserWatchingTabData (the loader seam)", () => {
  it("anonymous: only PUBLIC watched repos (Private = ctx.IsSigned false)", async () => {
    await seedBaseFixtures();
    const data = await loadUserWatchingTabData(env.DB, await userRow("gal"), anon, new URLSearchParams());

    // gal/open + ally/openally + hid/pubrow; the private rows (secret,
    // stash, den) drop — star/watch metadata does not leak.
    expect(data.repos.map((item) => item.repo.slug)).toEqual(["open", "openally", "pubrow"]);
    expect(data.total).toBe(3);
    expect(data.page).toBe(1);
    expect(data.more).toBe(false);
  });

  it("self: the owned-by-doer arm — gal's own private watched repo shows, ally's stays hidden", async () => {
    await seedBaseFixtures();
    const self = await loadUserWatchingTabData(
      env.DB,
      await userRow("gal"),
      { id: (await userRow("gal")).id, isAdmin: false },
      new URLSearchParams(),
    );
    // The landed lister's WHERE: public rows + rows whose namespace is the
    // doer's login — gal/secret qualifies, ally/stash and stranger/den do
    // not (the reduced ACL's documented drop of upstream's collaborator
    // arm — the social-lists header note).
    expect(self.repos.map((item) => item.repo.slug)).toEqual(["open", "secret", "openally", "pubrow"]);
    expect(self.total).toBe(4);
  });

  it("a signed-in stranger: public rows + private rows the STRANGER owns that gal watches", async () => {
    await seedBaseFixtures();
    const strangerData = await loadUserWatchingTabData(
      env.DB,
      await userRow("gal"),
      { id: (await userRow("stranger")).id, isAdmin: false },
      new URLSearchParams(),
    );
    // stranger/den is private AND owned by the doer → the owned-by-doer arm
    // keeps it (the arm the stars lister's collapsed seePrivate loses).
    expect(strangerData.repos.map((item) => item.repo.slug)).toEqual(["open", "openally", "pubrow", "den"]);
    expect(strangerData.total).toBe(4);
  });

  it("admin: the filter drops entirely — every watched row renders in the lister's numeric order", async () => {
    await seedBaseFixtures();
    const adminData = await loadUserWatchingTabData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    expect(adminData.repos.map((item) => item.repo.slug)).toEqual([
      "open",
      "secret",
      "openally",
      "stash",
      "pubrow",
      "den",
    ]);
    expect(adminData.total).toBe(6);
    // The lister's CAST(id AS INTEGER) order held on every arm above (the
    // fixture ids ascend with the array).
  });

  it("paging: RepoPagingNum=15 per page, the more flag, and the clamp (page ≤ 0/junk → 1)", async () => {
    await seedPagingFixtures();
    const bulk = await userRow("bulk");

    const page1 = await loadUserWatchingTabData(env.DB, bulk, admin, new URLSearchParams());
    expect(page1.repos).toHaveLength(15);
    expect(page1.total).toBe(16);
    expect(page1.more).toBe(true);

    const page2 = await loadUserWatchingTabData(env.DB, bulk, admin, new URLSearchParams("page=2"));
    expect(page2.repos).toHaveLength(1);
    expect(page2.more).toBe(false);
    expect(page2.page).toBe(2);

    for (const junk of ["0", "-3", "page", "1.5"]) {
      const clamped = await loadUserWatchingTabData(env.DB, bulk, admin, new URLSearchParams(`page=${junk}`));
      expect(clamped.page, junk).toBe(1);
      expect(clamped.repos, junk).toHaveLength(15);
    }
  });

  it("the Repositories header count rides the doer-visible WHERE; the avatar card's totals are real", async () => {
    await seedBaseFixtures();
    // gal owns open (public) + secret (private): a stranger's count sees
    // the public row only, admin/self both.
    const strangerData = await loadUserWatchingTabData(
      env.DB,
      await userRow("gal"),
      { id: (await userRow("stranger")).id, isAdmin: false },
      new URLSearchParams(),
    );
    expect(strangerData.repoCount).toBe(1);

    const adminData = await loadUserWatchingTabData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    expect(adminData.repoCount).toBe(2);
    expect(adminData.followers).toBe(1); // ally follows gal
    expect(adminData.following).toBe(0);
  });

  it("descriptions ride the batched repo_settings read; rows carry the owner visibility", async () => {
    await seedBaseFixtures();
    const data = await loadUserWatchingTabData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    const open = data.repos.find((item) => item.repo.slug === "open");
    expect(open?.description).toBe("her open repo");
    const secret = data.repos.find((item) => item.repo.slug === "secret");
    expect(secret?.description).toBe(""); // no repo_settings row → ""
    const pubrow = data.repos.find((item) => item.repo.slug === "pubrow");
    expect(pubrow?.ownerVisibility).toBe("private"); // the internal-badge arm's input
  });
});

// --- the render (shared/repo/list.tmpl's watching arm) -------------------------

describe("WatchingRepoListItem (list.tmpl's row under the watching gates)", () => {
  /** Rows render from REAL seeded rows (the admin loader sees every arm). */
  async function itemOf(slug: string): Promise<WatchingRepoItem> {
    const data = await loadUserWatchingTabData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    const item = data.repos.find((candidate) => candidate.repo.slug === slug);
    if (item === undefined) throw new Error(`fixture row missing: ${slug}`);
    return item;
  }

  it("the title is the repo NAME only (ShowRepoOwnerOnList unset) linking /{owner}/{repo}; chips render", async () => {
    await seedBaseFixtures();
    const html = renderToString(<WatchingRepoListItem item={await itemOf("open")} />);
    expect(html).toContain('<a class="tw-text-primary name" href="/gal/open">open</a>');
    expect(html).not.toContain('href="/gal">gal</a>/'); // NO owner segment on the watching rows
    expect(html).toContain('href="/gal/open/stars"'); // the star chip (DisableStars false)
    expect(html).toContain("octicon-star");
    expect(html).toContain('href="/gal/open/pulls"');
    expect(html).toContain(">3</span>"); // the star count (both chips show 3: 3 stars, 5-2 pulls)
    expect(html).not.toContain("octicon-repo-forked"); // the forks chip: no D1 counter (§3.1)
    expect(html).not.toContain("show-modal"); // the watch gear: $.Watches unset by profile.go
    expect(html).toContain("her open repo"); // the description body
    expect(html).toContain("Updated"); // the org.repo_updated line
    expect(html).toContain("octicon-repo"); // the leading row glyph (icon.tmpl's plain arm — this fixture row is neither fork nor mirror)
  });

  it("the badges: private rows badge Private; public rows under private owners badge Internal", async () => {
    await seedBaseFixtures();
    const secretHtml = renderToString(<WatchingRepoListItem item={await itemOf("secret")} />);
    expect(secretHtml).toContain("Private</span>");
    expect(secretHtml).not.toContain("Internal</span>");

    const pubrowHtml = renderToString(<WatchingRepoListItem item={await itemOf("pubrow")} />);
    expect(pubrowHtml).toContain("Internal</span>"); // per-ROW owner visibility
    expect(pubrowHtml).not.toContain(">Private</span>");

    const openHtml = renderToString(<WatchingRepoListItem item={await itemOf("open")} />);
    expect(openHtml).not.toContain("ui basic label"); // no badge on a plain public row
  });
});

describe("EyeIcon (the inline eye glyph)", () => {
  it("renders the submodule's octicon-eye body with shell-Icon's DOM", () => {
    const html = renderToString(<EyeIcon />);
    expect(html).toContain('class="svg octicon-eye"');
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<path d=\"M8 2c1.981");
  });
});

// --- the full document (profile.tmpl's grid, the {{else}} branch) ---------------

describe("UserWatchingTabPage (the full-document render)", () => {
  it("renders the profile grid with the avatar card, the ACTIVE watching strip item and the rows", async () => {
    await seedBaseFixtures();
    const data = await loadUserWatchingTabData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    const html = renderToString(<UserWatchingTabPage ctx={ctx} data={data} />);

    expect(html).toContain('class="page-content user profile"'); // profile.tmpl:2's discriminator
    expect(html).toContain('id="profile-avatar-card"'); // the four-wide column's card
    expect(html).toContain(">1 followers</a>"); // the REAL totals as the tab anchors (profile_big_avatar.tmpl:25 — the F2 fold)
    expect(html).toContain(">0 following</a>");
    // The strip: repositories + activity INACTIVE, watching ACTIVE
    // (header.tmpl:44's DisableStars arm) with the eye glyph and NO count.
    expect(html).toContain('class="item" href="/gal?tab=repositories"');
    expect(html).toContain('class="item" href="/gal?tab=activity"');
    expect(html).toContain('class="active item" href="/gal?tab=watching"');
    expect(html).toContain("octicon-eye");
    expect(html).toContain("Watched Repositories</a>");
    expect(html).not.toContain('class="active item" href="/gal?tab=repositories"');
    // The Repositories count label (admin sees both gal repos) sits on the
    // repositories item only.
    expect(html).toContain('<div class="ui small label">2</div>');
    // The rows + the bare list wrapper (NO .stars div — profile.tmpl's
    // {{else}} branch, not the stars branch).
    expect(html).not.toContain('class="stars"');
    expect(html).toContain('class="flex-divided-list items-with-main"');
    expect(html).toContain('href="/gal/open">open</a>');
    expect(html).toContain('href="/ally/stash">stash</a>'); // admin sees every watched row
  });

  it("renders the mirror/fork/plain glyphs per icon.tmpl's chain — mirror row octicon-mirror, fork row octicon-repo-forked, plain row octicon-repo", async () => {
    await seedBaseFixtures();
    // The fork + mirror edges on two more gal-owned public rows (watched, so
    // the rows land): fork_parent points at the source row, is_mirror is the
    // pull-mirror flag — exactly the D1 state upstream's repo/icon.tmpl
    // branches on ($.IsMirror / $.ForkID). Ids keep the numeric ordering
    // convention (after the 1001-1006 fixtures).
    const gal = await userRow("gal");
    await seedRepo({ id: "1007", owner: "gal", slug: "afork", visibility: "public" });
    await seedRepo({ id: "1008", owner: "gal", slug: "amirror", visibility: "public" });
    await drizzle(env.DB)
      .update(repositories)
      .set({ forkParent: "1001" }) // forks gal/open (the first fixture row)
      .where(eq(repositories.id, "1007"))
      .run();
    await drizzle(env.DB).update(repositories).set({ isMirror: true }).where(eq(repositories.id, "1008")).run();
    for (const id of ["1007", "1008"]) {
      await drizzle(env.DB).insert(repoWatchers).values({ repoId: id, userId: gal.id });
    }

    const data = await loadUserWatchingTabData(env.DB, await userRow("gal"), admin, new URLSearchParams());
    const html = renderToString(<UserWatchingTabPage ctx={ctx} data={data} />);
    // Each `<div class="item">` chunk carries its own row's item-leading
    // glyph (rendered BEFORE the name link) + its own link — the org-home
    // matrix shape; the avatar card's `div.item`s precede the rows and match
    // none of the row hrefs (the followers/following anchors carry ?tab=).
    const chunks = html.split('<div class="item">');
    // Mirror first (icon.tmpl's `{{else if $.IsMirror}}` arm precedes the
    // fork arm — a hypothetical mirror+fork row would render the mirror
    // glyph): the mirror row's chunk carries octicon-mirror only.
    const mirrorRow = chunks.find((chunk) => chunk.includes('href="/gal/amirror"'));
    expect(mirrorRow, "amirror").toBeDefined();
    expect(mirrorRow, "amirror").toContain('class="svg octicon-mirror"'); // the $.IsMirror arm
    expect(mirrorRow, "amirror").toContain('width="24"'); // repo/icon.tmpl's 24px slot
    expect(mirrorRow, "amirror").not.toContain("octicon-repo-forked");
    expect(mirrorRow, "amirror").not.toContain('class="svg octicon-repo"');
    // The fork row's chunk carries octicon-repo-forked only ($.IsFork).
    const forkRow = chunks.find((chunk) => chunk.includes('href="/gal/afork"'));
    expect(forkRow, "afork").toBeDefined();
    expect(forkRow, "afork").toContain('class="svg octicon-repo-forked"'); // the $.IsFork arm
    expect(forkRow, "afork").toContain('width="24"'); // the same 24px slot
    expect(forkRow, "afork").not.toContain("octicon-mirror");
    expect(forkRow, "afork").not.toContain('class="svg octicon-repo"');
    // The plain row keeps the else arm (the ADDED pins: the earlier
    // characterization had no fork/mirror glyph arm — the rows previously
    // rendered the fallback glyph unconditionally, the divergence
    // org-glyph flagged).
    const plainRow = chunks.find((chunk) => chunk.includes('href="/gal/open"'));
    expect(plainRow, "open").toBeDefined();
    expect(plainRow, "open").toContain('class="svg octicon-repo"'); // the else arm
    expect(plainRow, "open").toContain('width="24"'); // the same 24px slot
    expect(plainRow, "open").not.toContain("octicon-mirror");
    expect(plainRow, "open").not.toContain("octicon-repo-forked");
  });

  it("the empty state is the list's range-else arm; a single page renders no pager", async () => {
    await seedBaseFixtures();
    const empty = await loadUserWatchingTabData(env.DB, await userRow("hid"), anon, new URLSearchParams());
    expect(empty.repos).toHaveLength(0);
    const html = renderToString(<UserWatchingTabPage ctx={ctx} data={empty} />);
    expect(html).toContain("No matching results found."); // search.no_results
    expect(html).not.toContain("center page buttons");

    // The visibility filter shows through: hid watches nothing, and even
    // the watched rows of others never leak into her page.
    expect(html).not.toContain('href="/gal/open"');
  });

  it("the pager keeps tab=watching on every link; page 1 is the bare ?tab= URL", async () => {
    await seedPagingFixtures();
    const data = await loadUserWatchingTabData(env.DB, await userRow("bulk"), admin, new URLSearchParams());
    const html = renderToString(<UserWatchingTabPage ctx={ctx} data={data} />);
    expect(html).toContain('<span class="navigation_label">Older</span>');
    expect(html).toContain('href="/bulk?tab=watching&amp;page=2"'); // renderToString escapes the &amp;
    expect(html).not.toContain("Newer"); // page 1 has no Newer link

    const page2 = await loadUserWatchingTabData(env.DB, await userRow("bulk"), admin, new URLSearchParams("page=2"));
    const tail = renderToString(<UserWatchingTabPage ctx={ctx} data={page2} />);
    expect(tail).toContain('<span class="navigation_label">Newer</span>');
    expect(tail).toContain('href="/bulk?tab=watching"'); // page 1 without a page param
    expect(tail).not.toContain("Older");
  });
});
