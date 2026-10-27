/**
 * The user settings REPOS tab module's tests (the bench-row UNMOUNTED
 * module — the user-watching-tab.test.tsx harness: real D1 via the vitest
 * plugin, generated migrations in beforeAll, the loader driven directly,
 * hono/jsx renderToString for the DOM; NO route-level arms — the route is
 * unmounted at these gates, the deferred matrix rides the wiring wave per
 * the module header's HANDOFF): the self-list loader (profile.go:302-320's
 * else arm — owner_id-scoped, private included, slug ASC, paged at 50),
 * the forked-from projection (the batched parent reads, the dangling-edge
 * posture), and the repos.tmpl:80-113 DOM — the kind-icon chain, the size
 * bytes, the forked-from line, the pager, the empty state, the
 * scaffolding nav's active repos item, and the degradation negatives (no
 * adopt/delete controls, no dir glyph, no unadopted shapes).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { UserSettingsNavbar } from "../components/settings-nav";
import {
  loadUserSettingsReposPageData,
  renderUserSettingsReposPage,
  UserSettingsReposPage,
  userSettingsReposLocale,
  USER_SETTINGS_REPOS_PAGE_SIZE,
} from "./user-settings-repos";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const FIXED_DATE = new Date("2026-01-15T00:00:00Z");

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** Insert a user row directly (the watching-tab fixture pattern) and return
 *  the full row. `username` may carry display case; `usernameLower` folds. */
async function seedUser(username: string, usernameLower = username.toLowerCase()) {
  await drizzle(env.DB).insert(users).values({ username, usernameLower, visibility: "public", createdAt: FIXED_DATE });
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, usernameLower)).get();
  if (row === undefined) throw new Error(`fixture user missing: ${username}`);
  return row;
}

interface RepoSpec {
  id: string;
  ownerId: number;
  ownerNamespace: string;
  slug: string;
  visibility?: "public" | "private";
  sizeKb?: number;
  isMirror?: boolean;
  isTemplate?: boolean;
  forkParent?: string | null;
}

/** Insert a repositories row (the required NOT NULL defaults ride along). */
async function seedRepo(spec: RepoSpec): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id: spec.id,
    storageKey: spec.id,
    ownerNamespace: spec.ownerNamespace,
    ownerId: spec.ownerId,
    slug: spec.slug,
    visibility: spec.visibility ?? "public",
    sizeKb: spec.sizeKb ?? 0,
    isMirror: spec.isMirror ?? false,
    isTemplate: spec.isTemplate ?? false,
    forkParent: spec.forkParent ?? null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  });
}

/** The standard world: alice owns five differently-shaped repos + one
 *  dangling fork; bob owns the fork source and one repo of his own. */
async function seedWorld(): Promise<{ aliceId: number; bobId: number; ctx: UiContext }> {
  const alice = await seedUser("alice");
  const bob = await seedUser("Bob"); // display case differs from the folded namespace
  await seedRepo({ id: "2001", ownerId: alice.id, ownerNamespace: "alice", slug: "alpha", sizeKb: 1024 });
  await seedRepo({ id: "2002", ownerId: alice.id, ownerNamespace: "alice", slug: "vault", visibility: "private" });
  await seedRepo({ id: "2003", ownerId: alice.id, ownerNamespace: "alice", slug: "mirrorbox", isMirror: true });
  await seedRepo({ id: "2004", ownerId: alice.id, ownerNamespace: "alice", slug: "seedling", isTemplate: true });
  await seedRepo({ id: "2005", ownerId: alice.id, ownerNamespace: "alice", slug: "zoofork", forkParent: "2101" });
  await seedRepo({ id: "2006", ownerId: alice.id, ownerNamespace: "alice", slug: "aardfork", forkParent: "9999" }); // dangling edge
  await seedRepo({ id: "2101", ownerId: bob.id, ownerNamespace: "bob", slug: "source" });
  await seedRepo({ id: "2102", ownerId: bob.id, ownerNamespace: "bob", slug: "bobs" });
  const viewer: UiContext = {
    viewer: { kind: "user", id: alice.id, username: "alice", isAdmin: false },
    origin: ORIGIN,
    assets: shellAssetsFromManifest(manifest),
  };
  return { aliceId: alice.id, bobId: bob.id, ctx: viewer };
}

// --- the loader ---------------------------------------------------------------

describe("loadUserSettingsReposPageData (profile.go:302-320's else arm)", () => {
  it("lists the doer's OWN rows only — private included, slug ASC, others' excluded", async () => {
    const { aliceId, bobId } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    // Private rows ride the self view (upstream Private: true); bob's two
    // repos stay out (owner_id-scoped); the slug order is ascending.
    expect(data.repos.map((item) => item.name)).toEqual(["aardfork", "alpha", "mirrorbox", "seedling", "vault", "zoofork"]);
    expect(data.repos.every((item) => item.ownerName === "alice")).toBe(true);
    expect(data.ownerName).toBe("alice");
    expect(data.page).toBe(1);
    expect(data.more).toBe(false);
    // Sanity: bob's own page lists exactly his two.
    const bobData = await loadUserSettingsReposPageData(env.DB, bobId, new URLSearchParams());
    expect(bobData?.repos.map((item) => item.name)).toEqual(["bobs", "source"]);
  });

  it("a user with no repositories loads the empty page", async () => {
    const carol = await seedUser("carol");
    const data = await loadUserSettingsReposPageData(env.DB, carol.id, new URLSearchParams());
    expect(data).toEqual({ ownerName: "carol", repos: [], page: 1, more: false });
  });

  it("pages at UserPagingNum=50 and computes the Older flag", async () => {
    const { aliceId } = await seedWorld();
    // 45 more rows on top of the seeded 6 → 51 total.
    for (let i = 0; i < USER_SETTINGS_REPOS_PAGE_SIZE - 5; i++) {
      await seedRepo({
        id: String(3000 + i),
        ownerId: aliceId,
        ownerNamespace: "alice",
        slug: `bulk${String(i).padStart(2, "0")}`,
      });
    }
    const page1 = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    expect(page1?.repos.length).toBe(USER_SETTINGS_REPOS_PAGE_SIZE);
    expect(page1?.more).toBe(true);
    const page2 = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams("page=2"));
    expect(page2?.repos.length).toBe(1);
    expect(page2?.more).toBe(false);
    // A page past the end is the empty page (parsePageNumber keeps it >= 1).
    const page3 = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams("page=3"));
    expect(page3?.repos).toEqual([]);
    expect(page3?.page).toBe(3);
    // A garbage page param parses as page 1 (parsePageNumber).
    const garbage = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams("page=nope"));
    expect(garbage?.page).toBe(1);
  });

  it("projects forkedFrom off the parent row with the display-case owner name", async () => {
    const { aliceId } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const fork = data.repos.find((item) => item.name === "zoofork");
    // The parent is Bob's repo: display-case "Bob" from the users row, the
    // case-folded /bob/source href (the admin-repos href rule).
    expect(fork?.isFork).toBe(true);
    expect(fork?.forkedFrom).toEqual({ ownerName: "Bob", name: "source", href: "/bob/source" });
    // A plain repo carries no fork shape at all.
    const plain = data.repos.find((item) => item.name === "alpha");
    expect(plain?.isFork).toBe(false);
    expect(plain?.forkedFrom).toBeNull();
  });

  it("a dangling fork edge stays a fork but renders no forked-from line", async () => {
    const { aliceId } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    const dangling = data?.repos.find((item) => item.name === "aardfork");
    expect(dangling?.isFork).toBe(true);
    expect(dangling?.forkedFrom).toBeNull();
  });

  it("a userId with no users row loads null (the silent-auth-failure 404 input)", async () => {
    expect(await loadUserSettingsReposPageData(env.DB, 424242, new URLSearchParams())).toBeNull();
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the repos settings DOM (repos.tmpl:80-113, the else branch)", () => {
  it("renders the discriminator, the header, and one row per owned repo", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    expect(html).toContain("user settings repos"); // the §2.4.1 discriminator
    expect(html).toContain('<h4 class="ui top attached header">Repositories</h4>');
    expect(html).toContain('class="ui list"');
    // The row: .Link href + Owner/Name text + FormatByteSize(sizeKb * 1024)
    // — 1024 KiB → 1 MiB.
    expect(html).toContain('<a class="name" href="/alice/alpha">alice/alpha</a>');
    expect(html).toContain("<span>1.0 MiB</span>");
    // The full-document render path matches the component path.
    expect(renderUserSettingsReposPage(ctx, data)).toContain('href="/alice/alpha"');
  });

  it("renders the kind icons off the repos.tmpl:86-96 chain", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    expect(html).toContain("octicon-lock"); // vault (private)
    expect(html).toContain("tw-text-gold"); // the lock's gold class
    expect(html).toContain("octicon-repo-forked"); // zoofork
    expect(html).toContain("octicon-mirror"); // mirrorbox
    expect(html).toContain("octicon-repo-template"); // seedling
    expect(html).toContain('class="svg octicon-repo"'); // alpha's default glyph
  });

  it("a PRIVATE fork renders the lock AND the forked-from line (the chain and the line are independent)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("Bob");
    await seedRepo({ id: "2101", ownerId: bob.id, ownerNamespace: "bob", slug: "source" });
    await seedRepo({ id: "2005", ownerId: alice.id, ownerNamespace: "alice", slug: "zoofork", visibility: "private", forkParent: "2101" });
    const data = await loadUserSettingsReposPageData(env.DB, alice.id, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const ctx: UiContext = {
      viewer: { kind: "user", id: alice.id, username: "alice", isAdmin: false },
      origin: ORIGIN,
      assets: shellAssetsFromManifest(manifest),
    };
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    expect(html).toContain("octicon-lock");
    expect(html).toContain("tw-text-gold");
    expect(html).not.toContain("octicon-repo-forked"); // the icon chain short-circuits at private
    expect(html).toContain(userSettingsReposLocale.forked_from); // the line still renders
    expect(html).toContain('href="/bob/source"');
    expect(html).toContain("Bob/source");
  });

  it("renders the forked-from line with the parent's display-case name", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    expect(html).toContain("forked from");
    expect(html).toContain('<a href="/bob/source">Bob/source</a>');
  });

  it("renders the empty state — the bare repos_none item, no list, no pager, no adopt shapes", async () => {
    const carol = await seedUser("carol");
    const ctx: UiContext = {
      viewer: { kind: "user", id: carol.id, username: "carol", isAdmin: false },
      origin: ORIGIN,
      assets: shellAssetsFromManifest(manifest),
    };
    const data = await loadUserSettingsReposPageData(env.DB, carol.id, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    expect(html).toContain(userSettingsReposLocale.repos_none);
    expect(html).not.toContain('class="ui list"');
    expect(html).not.toContain("pagination menu");
  });

  it("renders the Newer/Older pager off the loaded page state (inside the non-empty branch)", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null || data.repos[0] === undefined) throw new Error("fixture repos missing");
    const paged = renderToString(
      <UserSettingsReposPage ctx={ctx} data={{ ownerName: data.ownerName, repos: [data.repos[0]], page: 2, more: true }} />,
    );
    expect(paged).toContain("ui borderless pagination menu");
    expect(paged).toContain('href="/user/settings/repos?page=1"');
    expect(paged).toContain('href="/user/settings/repos?page=3"');
    const plain = renderToString(
      <UserSettingsReposPage ctx={ctx} data={{ ownerName: data.ownerName, repos: [data.repos[0]], page: 1, more: false }} />,
    );
    expect(plain).not.toContain("pagination menu");
  });

  it("renders the degradation posture — no adopt/delete controls, no dir glyph, no modal shapes", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    // The adopt/delete branch's shapes (repos.tmpl:7-72) render nothing.
    expect(html).not.toContain("unadopted");
    expect(html).not.toContain("adopt");
    expect(html).not.toContain("show-modal");
    expect(html).not.toContain("modal-dialog");
    expect(html).not.toContain("octicon-file-directory-fill"); // the adopt branch's dir glyph
    // The adopt branch's size span carries the SizeDetailsString tooltip
    // (repos.tmpl:27); the else-branch span is bare. Scoped to the span —
    // the shared BaseLayout navbar chrome carries its own tooltips.
    expect(html).not.toContain("<span data-tooltip-content");
  });

  it("the scaffolding nav renders the repos item active, exactly once", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserSettingsReposPageData(env.DB, aliceId, new URLSearchParams());
    if (data === null) throw new Error("loader returned null");
    const html = renderToString(<UserSettingsReposPage ctx={ctx} data={data} />);
    expect(html).toContain('class="active item" href="/user/settings/repos"');
    expect(html).toContain("Repositories"); // the item text (settings.repos)
    // Exactly once on a single-page render (more=false — no pager hrefs to
    // double-count).
    expect(html.split('href="/user/settings/repos"').length - 1).toBe(1);
    // The nav-only pin: the SHARED navbar (the wiring wave's swap — the
    // module-local scaffolding deleted) carries the repos tail.
    const nav = renderToString(<UserSettingsNavbar active="repos" />);
    expect(nav).toContain('class="flex-container-nav"');
    expect(nav).toContain('href="/user/settings"');
    expect(nav).toContain('href="/user/settings/account"');
    expect(nav).toContain('href="/user/settings/notifications"');
    expect(nav).toContain('class="active item" href="/user/settings/repos"');
    expect(nav).toContain('href="/user/settings/organization"'); // the item precedes repos
  });

  it("throws without a signed-in viewer (the settings pages' self-scoped contract)", async () => {
    const { ctx } = await seedWorld();
    const anonCtx: UiContext = { viewer: { kind: "anonymous" }, origin: ORIGIN, assets: ctx.assets };
    expect(() =>
      renderToString(
        <UserSettingsReposPage ctx={anonCtx} data={{ ownerName: "alice", repos: [], page: 1, more: false }} />,
      ),
    ).toThrow("UserSettingsReposPage requires a signed-in viewer");
  });
});
