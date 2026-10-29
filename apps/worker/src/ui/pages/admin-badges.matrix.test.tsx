/**
 * The ADMIN BADGES family's matrix: the catalog CRUD ports (create/update/
 * delete over the module-local Drizzle — the census's "web-only upstream,
 * no API contract" note), the paged list/search/sort, the badge-users edge
 * arms over the LANDED services/badges.ts (add/remove), and each page's DOM
 * contract (list/new/view/edit/users at the pin) — including the live
 * Create/Manage links, the scoped thead, and the re-render error lines.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { badges, userBadges, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  ADMIN_BADGES_PAGE_SIZE,
  AdminBadgesPage,
  AdminBadgeEditPage,
  AdminBadgeNewPage,
  AdminBadgeUsersPage,
  AdminBadgeViewPage,
  addBadgeUserByName,
  adminBadgesLocale,
  createBadgeFromForm,
  deleteBadgeBySlug,
  getBadgeBySlug,
  getBadgeUsersPage,
  loadAdminBadgesData,
  parseAdminBadgeForm,
  removeBadgeUser,
  updateBadgeFromForm,
} from "./admin-badges";

const T0 = 1_700_000_000;
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

async function insertUser(username: string): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username, status: "active", createdAt: new Date(T0 * 1000) })
    .returning({ id: users.id })
    .all();
  return inserted[0]!.id;
}

/** Two catalog rows with pinned slugs/descriptions + one edge (alice holds
 *  ci-passed). Ids captured at seed time. */
async function seedBadgeWorld(): Promise<{ ciId: number; docsId: number; aliceId: number }> {
  const aliceId = await insertUser("alice");
  const created = await drizzle(env.DB)
    .insert(badges)
    .values([
      { slug: "ci-passed", description: "The CI badge.", imageUrl: "https://img.test/ci.png" },
      { slug: "docs-hero", description: "The docs badge.", imageUrl: null },
    ])
    .returning({ id: badges.id })
    .all();
  const [ci, docs] = created;
  if (ci === undefined || docs === undefined) throw new Error("badge seed failed");
  await drizzle(env.DB).insert(userBadges).values({ badgeId: ci.id, userId: aliceId }).run();
  return { ciId: ci.id, docsId: docs.id, aliceId };
}

async function load(search: string | URLSearchParams) {
  return loadAdminBadgesData(env.DB, typeof search === "string" ? new URLSearchParams(search) : search);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["users", "sessions", "badge", "user_badge"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the catalog CRUD ----------------------------------------------------------

describe("the catalog CRUD (CreateBadge / UpdateBadge / DeleteBadge ports)", () => {
  it("create: the required-field bind first, then the slug-unique pre-check", async () => {
    expect(await createBadgeFromForm(env.DB, parseAdminBadgeForm(new URLSearchParams("slug=&description=x")))).toBe("invalid");
    expect(await createBadgeFromForm(env.DB, parseAdminBadgeForm(new URLSearchParams("slug=x&description=")))).toBe("invalid");
    expect(await createBadgeFromForm(env.DB, parseAdminBadgeForm(new URLSearchParams("slug=ci&description=CI badge&image_url=https://img.test/x.png")))).toBe("created");
    expect(await createBadgeFromForm(env.DB, parseAdminBadgeForm(new URLSearchParams("slug=ci&description=Again")))).toBe("slug-taken");
    const row = await getBadgeBySlug(env.DB, "ci");
    expect(row?.description).toBe("CI badge");
    expect(row?.imageUrl).toBe("https://img.test/x.png");
  });

  it("update: description + image_url only — the slug is the immutable key", async () => {
    const ids = await seedBadgeWorld();
    expect(
      await updateBadgeFromForm(env.DB, "ci-passed", {
        description: "Updated description.",
        imageUrl: "",
      }),
    ).toBe("updated");
    const row = await getBadgeBySlug(env.DB, "ci-passed");
    expect(row?.description).toBe("Updated description.");
    expect(row?.imageUrl).toBeNull(); // the blank URL clears the column
    expect(row?.slug).toBe("ci-passed");
    expect(row?.id).toBe(ids.ciId);
    expect(await updateBadgeFromForm(env.DB, "ci-passed", { description: "", imageUrl: "x" })).toBe("invalid");
  });

  it("delete: the edges first, then the badge; the unknown slug reports the miss", async () => {
    await seedBadgeWorld();
    expect((await drizzle(env.DB).select().from(userBadges).all()).length).toBe(1);
    expect(await deleteBadgeBySlug(env.DB, "ci-passed")).toBe(true);
    expect(await getBadgeBySlug(env.DB, "ci-passed")).toBeNull();
    expect((await drizzle(env.DB).select().from(userBadges).all()).length).toBe(0);
    expect(await deleteBadgeBySlug(env.DB, "ci-passed")).toBe(false);
  });
});

// --- the list -------------------------------------------------------------------

describe("loadAdminBadgesData — SearchBadges (the list)", () => {
  it("orders by the four sorts; junk folds onto oldest (BadgeSearchDefaultAdminSort)", async () => {
    await seedBadgeWorld();
    await drizzle(env.DB).insert(badges).values({ slug: "aaa-first", description: "Early." }).run();
    // id ASC: the seeded pair (ci id 1, docs id 2) then aaa-first (id 3).
    expect((await load("sort=oldest")).items.map((row) => row.slug)).toEqual(["ci-passed", "docs-hero", "aaa-first"]);
    expect((await load("sort=newest")).items.map((row) => row.slug)).toEqual(["aaa-first", "docs-hero", "ci-passed"]);
    expect((await load("sort=alphabetically")).items.map((row) => row.slug)).toEqual(["aaa-first", "ci-passed", "docs-hero"]);
    expect((await load("sort=reversealphabetically")).items.map((row) => row.slug)).toEqual(["docs-hero", "ci-passed", "aaa-first"]);
    expect((await load("sort=junk")).items.map((row) => row.slug)).toEqual(["ci-passed", "docs-hero", "aaa-first"]);
  });

  it("the keyword rides the slug substring; the pager query carries q + sort but never page", async () => {
    await seedBadgeWorld();
    expect((await load("q=CI")).items.map((row) => row.slug)).toEqual(["ci-passed"]); // case-folded
    expect((await load("q=zzz")).total).toBe(0);
    const data = await load("q=docs&sort=newest");
    expect(data.query.get("q")).toBe("docs");
    expect(data.query.get("sort")).toBe("newest");
    expect(data.query.has("page")).toBe(false);
  });

  it("paginates 50 per page (Admin.UserPagingNum)", async () => {
    for (let i = 0; i < ADMIN_BADGES_PAGE_SIZE + 1; i++) {
      await drizzle(env.DB).insert(badges).values({ slug: `b${String(i).padStart(2, "0")}`, description: null }).run();
    }
    const page1 = await load("");
    expect(page1.items).toHaveLength(ADMIN_BADGES_PAGE_SIZE);
    expect(page1.more).toBe(true);
    expect((await load("page=2")).items).toHaveLength(1);
  });
});

// --- the badge users -------------------------------------------------------------

describe("the badge-users edge arms (BadgeUsersPost / DeleteBadgeUser over services/badges.ts)", () => {
  it("add: the unknown-user, unknown-badge, and already-has arms; then the added arm", async () => {
    const ids = await seedBadgeWorld();
    expect(await addBadgeUserByName(env.DB, "ci-passed", "nobody")).toBe("user-missing");
    expect(await addBadgeUserByName(env.DB, "no-such-badge", "alice")).toBe("badge-missing");
    expect(await addBadgeUserByName(env.DB, "ci-passed", "Alice")).toBe("already-has"); // the lowercased lookup + the edge
    expect(await addBadgeUserByName(env.DB, "docs-hero", "alice")).toBe("added");
    expect((await drizzle(env.DB).select().from(userBadges).where(eq(userBadges.userId, ids.aliceId)).all()).length).toBe(2);
  });

  it("remove absorbs the unknown slug silently (RemoveUserBadges' no-op arm)", async () => {
    await seedBadgeWorld();
    const bobId = await insertUser("bob");
    await removeBadgeUser(env.DB, "docs-hero", bobId); // bob never held it — silence
    expect(await addBadgeUserByName(env.DB, "docs-hero", "bob")).toBe("added");
    await removeBadgeUser(env.DB, "docs-hero", bobId);
    expect((await getBadgeUsersPage(env.DB, "docs-hero", 1)).total).toBe(0);
  });

  it("getBadgeUsersPage: the paged join with the true total + more flag", async () => {
    await seedBadgeWorld();
    const bobId = await insertUser("bob");
    await addBadgeUserByName(env.DB, "ci-passed", "bob");
    const page = await getBadgeUsersPage(env.DB, "ci-passed", 1);
    expect(page.total).toBe(2);
    expect(page.more).toBe(false);
    expect(page.items.map((user) => user.username).sort()).toEqual(["alice", "bob"]);
    expect(bobId).toBeGreaterThan(0);
  });
});

// --- the renders -----------------------------------------------------------------

describe("the badge family DOM (templates/admin/badge/*.tmpl at the pin)", () => {
  it("the list renders the pageClass, the header + total + the LIVE Create link, the sort menu, and the star/pencil pair", async () => {
    await seedBadgeWorld();
    const html = renderToString(<AdminBadgesPage ctx={ctx} data={await load("")} />);
    expect(html).toContain('class="page-content admin badge"');
    // The Create button rides INSIDE the h4 (list.tmpl:5-8's ui right div) —
    // the header text is the assertion, not the closing tag.
    expect(html).toContain(`${adminBadgesLocale.badges_manage_panel} (${adminBadgesLocale.total.replace("%d", "2")})`);
    expect(html).toContain('href="/-/admin/badges/new"'); // the landed new page
    expect(html).toContain('name="sort" value="oldest"'); // the submit-button sort menu
    expect(html).toContain('<a href="/-/admin/badges/slug/ci-passed">ci-passed</a>');
    expect(html).toContain('href="/-/admin/badges/slug/ci-passed/edit"'); // the landed edit page
    expect(html.split('<th scope="col">').length - 1).toBe(4); // the scoped thead (the closed R6 gap)
  });

  it("the new page renders the required fields and the error arm re-renders with the submitted values", () => {
    const empty = renderToString(<AdminBadgeNewPage ctx={ctx} data={{ form: { slug: "", description: "", imageUrl: "" }, error: null }} />);
    expect(empty).toContain('class="page-content admin new badge"');
    expect(empty).toContain('name="slug"');
    expect(empty).not.toContain("ui negative message");
    const failed = renderToString(
      <AdminBadgeNewPage ctx={ctx} data={{ form: { slug: "ci-passed", description: "Dup", imageUrl: "" }, error: adminBadgesLocale.slug_been_taken }} />,
    );
    expect(failed).toContain(adminBadgesLocale.slug_been_taken);
    expect(failed).toContain('value="ci-passed"');
  });

  it("the view renders the badge info (the image arm), the users preview, and the LIVE Manage Users link", async () => {
    await seedBadgeWorld();
    const badge = await getBadgeBySlug(env.DB, "ci-passed");
    if (badge === null) throw new Error("seed lost");
    const usersPage = await getBadgeUsersPage(env.DB, "ci-passed", 1);
    const html = renderToString(
      <AdminBadgeViewPage ctx={ctx} data={{ badge, usersTotal: usersPage.total, usersPreview: usersPage.items.map((u) => ({ id: u.id, username: u.username })) }} />,
    );
    expect(html).toContain('src="https://img.test/ci.png"');
    expect(html).toContain("The CI badge.");
    expect(html).toContain(`(${usersPage.total})`);
    expect(html).toContain('<a href="/alice">alice</a>'); // the name-link reduction (no avatar pipeline)
    expect(html).toContain('href="/-/admin/badges/slug/ci-passed/edit"');
    expect(html).toContain('href="/-/admin/badges/slug/ci-passed/users"');
  });

  it("the edit renders the readonly slug, the update form, and the plain-form delete (the confirm-dialog reduction)", async () => {
    await seedBadgeWorld();
    const badge = await getBadgeBySlug(env.DB, "docs-hero");
    if (badge === null) throw new Error("seed lost");
    const html = renderToString(
      <AdminBadgeEditPage ctx={ctx} data={{ badge, form: { description: "The docs badge.", imageUrl: "" }, error: null }} />,
    );
    expect(html).toContain('class="page-content admin edit badge"');
    expect(html).toContain('readonly');
    expect(html).toContain('action="/-/admin/badges/slug/docs-hero/edit"');
    expect(html).toContain('action="/-/admin/badges/slug/docs-hero/delete"');
    expect(html).toContain(adminBadgesLocale.delete_badge_desc); // the reduction's inline desc
  });

  it("the users page renders the add form, the remove forms, and the error arm", async () => {
    await seedBadgeWorld();
    const badge = await getBadgeBySlug(env.DB, "ci-passed");
    if (badge === null) throw new Error("seed lost");
    const page = await getBadgeUsersPage(env.DB, "ci-passed", 1);
    const html = renderToString(
      <AdminBadgeUsersPage
        ctx={ctx}
        data={{
          badge,
          items: page.items.map((u) => ({ id: u.id, username: u.username, fullName: u.fullName })),
          total: page.total,
          more: page.more,
          page: 1,
          query: new URLSearchParams(),
          error: adminBadgesLocale.user_not_exist,
          submittedUser: "ghost",
        }}
      />,
    );
    expect(html).toContain('class="page-content admin badge"');
    expect(html).toContain(adminBadgesLocale.users_with_badge.replace("%s", "ci-passed"));
    expect(html).toContain(adminBadgesLocale.user_not_exist); // the re-rendered error line
    expect(html).toContain('value="ghost"'); // the submitted name carried over
    expect(html).toContain('action="/-/admin/badges/slug/ci-passed/users"');
    expect(html).toContain('action="/-/admin/badges/slug/ci-passed/users/delete"');
    expect(html).toContain(adminBadgesLocale.remove_user);
  });

  it("the family navbar renders the landed arms — Identity & Access open with Badges active", async () => {
    await seedBadgeWorld();
    const html = renderToString(<AdminBadgesPage ctx={ctx} data={await load("")} />);
    expect(html).toContain('class="active item" href="/-/admin/badges"');
    expect(html).toContain('href="/-/admin/emails"');
    expect(html).toContain('href="/-/admin/applications"');
    expect(html).not.toContain("/-/admin/auths");
    expect(html).not.toContain("/-/admin/notices");
  });
});
