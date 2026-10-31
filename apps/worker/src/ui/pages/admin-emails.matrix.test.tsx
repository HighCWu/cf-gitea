/**
 * The ADMIN EMAILS page's matrix (the mounted route posture cannot be
 * tested here — the activity-feeds.matrix harness drives the module's
 * load/render/write seams over real D1, generated migrations in beforeAll,
 * hono/jsx renderToString).
 *
 * Covered here:
 *   - the LOADER's union read: real rows JOIN users (type='user' — org rows
 *     never surface) + the SYNTHESIZED primaries (users.email with no row —
 *     the declared GET /admin/emails model), the keyword triple
 *     (lower_email/username/full_name, case-folded), the is_primary /
 *     is_activated filters over the REAL rows only (the synthesized set
 *     excluded under a filter — the module header's note), the four sorts
 *     with the composite tiebreaks, the junk-sort fold, and the 50-per-page
 *     pagination;
 *   - the WRITES: activate (the (uid, lower_email) row lookup's miss arm,
 *     the already-in-state no-op, the duplicate-active probe over other
 *     active rows AND other active users' primaries, the update), delete
 *     (the (uid, id) miss, the unreachable primary guard, the delete);
 *   - the RENDER's contract: the `admin user` pageClass (the template's own
 *     dict), the panel header with the total, the four-item sort menu with
 *     the active arm, the row projection (name link, plain state cells on
 *     the synthesized primaries, toggle/delete forms on real rows only),
 *     the scoped thead, the no-results row, the pager hrefs — and the
 *     dead-control assertions (a synthesized primary carries NO toggle and
 *     NO trash; the nav renders the landed arms only).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { emailAddresses } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  ADMIN_EMAILS_PAGE_SIZE,
  AdminEmailsPage,
  adminEmailsLocale,
  applyAdminEmailActivate,
  applyAdminEmailDelete,
  adminEmailActivateFormValid,
  loadAdminEmailsData,
  parseAdminEmailActivateForm,
  parseAdminEmailsListParams,
} from "./admin-emails";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin — the route stage's gate (web.go:779) is the
 *  wiring's posture; the module trusts its inputs. */
const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

interface UserInsert {
  username: string;
  fullName?: string;
  email?: string;
  type?: "user" | "org";
}

async function insertUser(insert: UserInsert): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, display_name, full_name, email, is_admin, status, type, visibility, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 0, 'active', ?, 'public', ?)",
  )
    .bind(
      insert.username,
      insert.username.toLowerCase(),
      insert.fullName ?? insert.username,
      insert.fullName ?? null,
      insert.email ?? null,
      insert.type ?? "user",
      T0,
    )
    .run();
  return result.meta.last_row_id;
}

async function insertEmail(userId: number, email: string, opts?: { isActivated?: boolean; isPrimary?: boolean }): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(userId, email, email.toLowerCase(), opts?.isActivated === false ? 0 : 1, opts?.isPrimary === true ? 1 : 0)
    .run();
  return result.meta.last_row_id;
}

/** The standard fixture set: root (admin, synthesized primary), alice
 *  (synthesized primary + one active secondary), bob (synthesized primary +
 *  one INACTIVE secondary), an org (never surfaces). */
async function seedBaseFixtures(): Promise<void> {
  const rootId = await insertUser({ username: "root", fullName: "Root Admin", email: "root@test.local" });
  await insertEmail(rootId, "root-alt@test.local");
  const aliceId = await insertUser({ username: "alice", fullName: "Alice Doe", email: "alice@test.local" });
  await insertEmail(aliceId, "alice-alt@test.local");
  const bobId = await insertUser({ username: "bob", fullName: "Bob Banner", email: "bob@test.local" });
  await insertEmail(bobId, "bob-alt@test.local", { isActivated: false });
  await insertUser({ username: "myorg", fullName: "The Org", type: "org" });
}

async function load(search: string | URLSearchParams, doerId = 1) {
  return loadAdminEmailsData(env.DB, doerId, typeof search === "string" ? new URLSearchParams(search) : search);
}

function render(data: Awaited<ReturnType<typeof load>>): string {
  return renderToString(<AdminEmailsPage ctx={ctx} data={data} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["users", "sessions", "email_addresses", "org_members", "teams"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader: the union read ----------------------------------------------

describe("loadAdminEmailsData — the union read", () => {
  it("unions the real secondary rows with the synthesized primaries; org rows never surface", async () => {
    await seedBaseFixtures();
    const data = await load("");
    // Three synthesized primaries (root/alice/bob — the org carries no
    // email) + three real secondary rows (root-alt/alice-alt/bob-alt) = 6.
    expect(data.total).toBe(6);
    expect(data.items.filter((entry) => entry.isPrimary).map((entry) => entry.email).sort()).toEqual([
      "alice@test.local",
      "bob@test.local",
      "root@test.local",
    ]);
    expect(data.items.filter((entry) => entry.id !== null).map((entry) => entry.email).sort()).toEqual([
      "alice-alt@test.local",
      "bob-alt@test.local",
      "root-alt@test.local",
    ]);
  });

  it("the keyword matches lower_email, username, and full name (case-folded) across BOTH halves of the union", async () => {
    await seedBaseFixtures();
    // Every real secondary row carries the "-alt@test.local" substring.
    expect((await load("q=alt@test")).items.map((entry) => entry.email).sort()).toEqual([
      "alice-alt@test.local",
      "bob-alt@test.local",
      "root-alt@test.local",
    ]);
    expect((await load("q=ALICE")).items.map((entry) => entry.email).sort()).toEqual(["alice-alt@test.local", "alice@test.local"]);
    expect((await load("q=doe")).total).toBe(2); // alice's full name — both halves
    expect((await load("q=nobody")).total).toBe(0);
  });

  it("is_primary/is_activated filter the REAL rows only and exclude the synthesized set", async () => {
    await seedBaseFixtures();
    // is_activated=0 → bob's inactive secondary; the primaries (synthesized,
    // always active) are not rows the filter can read — excluded.
    expect((await load("is_activated=0")).items.map((entry) => entry.email)).toEqual(["bob-alt@test.local"]);
    expect((await load("is_activated=1")).items.map((entry) => entry.email).sort()).toEqual([
      "alice-alt@test.local",
      "root-alt@test.local",
    ]);
    // is_primary=1 matches nothing (no real primary rows — the store's
    // synthesized-primary model); is_primary=0 lists every real row.
    expect((await load("is_primary=1")).total).toBe(0);
    expect((await load("is_primary=0")).total).toBe(3);
  });

  it("the junk sort folds onto email; the four sorts order by the composite keys", async () => {
    await seedBaseFixtures();
    const byEmail = await load("");
    // email ASC over lower_email: alice-alt < alice < bob-alt < bob < root-alt
    // < root (primary isPrimary DESC tiebreak is inert — unique emails).
    expect(byEmail.items.map((entry) => entry.email)).toEqual([
      "alice-alt@test.local",
      "alice@test.local",
      "bob-alt@test.local",
      "bob@test.local",
      "root-alt@test.local",
      "root@test.local",
    ]);
    expect(byEmail.params.sort).toBe("email");
    expect((await load("sort=junk")).params.sort).toBe("email"); // the default arm rewrites SortType
    expect((await load("sort=reverseemail")).items.map((entry) => entry.email)).toEqual(
      [...byEmail.items.map((entry) => entry.email)].reverse(),
    );
    const byName = await load("sort=username");
    expect(byName.items.map((entry) => entry.username)).toEqual([
      "alice",
      "alice",
      "bob",
      "bob",
      "root",
      "root",
    ]); // the synthesized primary rides its user's name key first (is_primary DESC)
    expect((await load("sort=reverseusername")).items.map((entry) => entry.username)).toEqual(
      [...byName.items.map((entry) => entry.username)].reverse(),
    );
    expect(parseAdminEmailsListParams(new URLSearchParams("sort=email")).sort).toBe("email");
  });

  it("paginates 50 per page over the merged array; the pager query carries q + the filters + sort but never page", async () => {
    await insertUser({ username: "pager", fullName: "P", email: "pager@test.local" });
    for (let i = 0; i < ADMIN_EMAILS_PAGE_SIZE; i++) {
      const id = await insertUser({ username: `u${String(i).padStart(2, "0")}`, email: `u${i}@test.local` });
      await insertEmail(id, `u${i}-alt@test.local`);
    }
    const page1 = await load("");
    expect(page1.items).toHaveLength(ADMIN_EMAILS_PAGE_SIZE);
    expect(page1.more).toBe(true);
    const page2 = await load("page=2");
    expect(page2.items.length).toBeGreaterThan(0);
    expect(page2.items.length).toBeLessThanOrEqual(ADMIN_EMAILS_PAGE_SIZE);
    expect((await load("q=alice&sort=reverseemail&is_activated=0")).query.get("q")).toBe("alice");
    expect((await load("q=alice")).query.has("page")).toBe(false);
    // The default sort never rides the URL.
    expect((await load("sort=email")).query.has("sort")).toBe(false);
  });
});

// --- the writes ---------------------------------------------------------------

describe("applyAdminEmailActivate — the ActivateUserEmail port", () => {
  it("misses the (uid, lower_email) row on the synthesized primaries (upstream's own no-such-email arm)", async () => {
    const rootId = await insertUser({ username: "root", email: "root@test.local" });
    const form = parseAdminEmailActivateForm(new URLSearchParams(`uid=${rootId}&email=root@test.local&primary=1&activate=0`));
    expect(await applyAdminEmailActivate(env.DB, form)).toBe("no-such-email");
  });

  it("bind-validates the four truefalse fields (the handler's 400 arm)", () => {
    expect(adminEmailActivateFormValid(parseAdminEmailActivateForm(new URLSearchParams("uid=0&email=a@b&primary=1&activate=1")))).toBe(false);
    expect(adminEmailActivateFormValid(parseAdminEmailActivateForm(new URLSearchParams("uid=1&email=&primary=1&activate=1")))).toBe(false);
    expect(adminEmailActivateFormValid(parseAdminEmailActivateForm(new URLSearchParams("uid=1&email=a@b&primary=yes&activate=1")))).toBe(false);
    expect(adminEmailActivateFormValid(parseAdminEmailActivateForm(new URLSearchParams("uid=1&email=a@b&primary=1&activate=maybe")))).toBe(false);
    expect(adminEmailActivateFormValid(parseAdminEmailActivateForm(new URLSearchParams("uid=1&email=a@b&primary=0&activate=0")))).toBe(true);
  });

  it("deactivates and re-activates a real row; the already-in-state arm is a no-op", async () => {
    const aliceId = await insertUser({ username: "alice", email: "alice@test.local" });
    const rowId = await insertEmail(aliceId, "alice-alt@test.local");
    expect(
      await applyAdminEmailActivate(env.DB, parseAdminEmailActivateForm(new URLSearchParams(`uid=${aliceId}&email=ALICE-ALT@TEST.LOCAL&primary=0&activate=0`))),
    ).toBe("updated");
    const after = await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.id, rowId)).get();
    expect(after?.isActivated).toBe(false);
    // Case-folded lookup — the lower_email arm.
    expect(await applyAdminEmailActivate(env.DB, parseAdminEmailActivateForm(new URLSearchParams(`uid=${aliceId}&email=alice-alt@test.local&primary=0&activate=0`)))).toBe("no-op");
    expect(await applyAdminEmailActivate(env.DB, parseAdminEmailActivateForm(new URLSearchParams(`uid=${aliceId}&email=alice-alt@test.local&primary=0&activate=1`)))).toBe("updated");
  });

  it("refuses to activate an address another ACTIVE user already holds (the users half of the duplicate-active probe)", async () => {
    // The ROWS half of upstream's IsEmailActive is UNPRODUCIBLE here: the
    // lower_email UNIQUE constraint means no second row can ever hold the
    // same address (the constraint is the dedup) — only the users half can
    // fire. alice's users.email blocks bob's row; the current user's own
    // primary is excluded (bob can activate a row equal to his own
    // users.email — upstream's IsEmailActive minus the doer).
    await insertUser({ username: "alice", email: "shared-user@test.local" });
    const bobId = await insertUser({ username: "bob", email: "bob@test.local" });
    await insertEmail(bobId, "shared-user@test.local", { isActivated: false });
    expect(
      await applyAdminEmailActivate(
        env.DB,
        parseAdminEmailActivateForm(new URLSearchParams(`uid=${bobId}&email=shared-user@test.local&primary=0&activate=1`)),
      ),
    ).toBe("duplicate-active");
    // Bob's own-primary-matching row activates fine (the ne(uid) arm).
    const carolId = await insertUser({ username: "carol", email: "carols-own@test.local" });
    await insertEmail(carolId, "carols-own@test.local", { isActivated: false });
    expect(
      await applyAdminEmailActivate(
        env.DB,
        parseAdminEmailActivateForm(new URLSearchParams(`uid=${carolId}&email=carols-own@test.local&primary=0&activate=1`)),
      ),
    ).toBe("updated");
  });
});

describe("applyAdminEmailDelete — the DeleteEmail port", () => {
  it("misses silently on a foreign id / unknown uid (the stale-form posture)", async () => {
    await seedBaseFixtures();
    expect(await applyAdminEmailDelete(env.DB, { uid: 999, id: 1 })).toBe("miss");
  });

  it("deletes the real row by (uid, id); the primary guard is the unreachable honest arm", async () => {
    const aliceId = await insertUser({ username: "alice", email: "alice@test.local" });
    const rowId = await insertEmail(aliceId, "alice-alt@test.local");
    expect(await applyAdminEmailDelete(env.DB, { uid: aliceId, id: rowId })).toBe("deleted");
    expect((await drizzle(env.DB).select().from(emailAddresses).all()).length).toBe(0);
    // The primary guard: plant one (no landed write path can — the honest
    // arm's direct probe).
    const planted = await insertEmail(aliceId, "planted@test.local", { isPrimary: true });
    expect(await applyAdminEmailDelete(env.DB, { uid: aliceId, id: planted })).toBe("primary");
    expect((await drizzle(env.DB).select().from(emailAddresses).all()).length).toBe(1);
  });
});

// --- the render -------------------------------------------------------------------

describe("the admin emails DOM (templates/admin/emails/list.tmpl at the pin)", () => {
  it("renders the pageClass, the panel header with the total, and the full row projection", async () => {
    await seedBaseFixtures();
    const html = render(await load(""));
    expect(html).toContain('class="page-content admin user"'); // the template's own dict (list.tmpl:1)
    expect(html).toContain(
      `>${adminEmailsLocale.email_manage_panel} (${adminEmailsLocale.total.replace("%d", "6")})</h4>`,
    );
    expect(html).toContain('<a href="/alice">alice</a>');
    expect(html).toContain("alice-alt@test.local");
    // The synthesized primaries render the plain cells: no toggle form, no
    // trash form (the dead-control rule) — the three REAL rows carry them.
    expect(html.split('action="/-/admin/emails/activate"').length - 1).toBe(3);
    expect(html.split('action="/-/admin/emails/delete"').length - 1).toBe(3);
    // The sort menu's four items with email active (the default).
    expect(html).toContain('class="active item" href="/-/admin/emails"');
    expect(html).toContain(`>${adminEmailsLocale.sort_email_reverse}</a>`);
    for (const header of [
      adminEmailsLocale.col_name,
      adminEmailsLocale.col_full_name,
      adminEmailsLocale.col_email,
      adminEmailsLocale.col_primary,
      adminEmailsLocale.col_activated,
    ]) {
      expect(html).toContain(header);
    }
  });

  it("every th carries scope=col (the closed R6 gap, the 132fec0 convention)", async () => {
    await seedBaseFixtures();
    const html = render(await load(""));
    const ths = html.match(/<th scope="col">/g) ?? [];
    expect(ths.length).toBe(6);
    // \b keeps <thead> out of the match (a bare <th> is the violation).
    expect(html).not.toMatch(/<th\b(?![^>]*scope=)[^>]*>/);
  });

  it("renders the no-results row (colspan 6) on an empty answer", async () => {
    await seedBaseFixtures();
    const html = render(await load("q=nobody"));
    expect(html).toContain('class="no-results-row"');
    expect(html).toContain('colspan="6"');
    expect(html).toContain(adminEmailsLocale.no_results);
  });

  it("renders the pager hrefs carrying the full param set", async () => {
    await seedBaseFixtures();
    const aliceId = await insertUser({ username: "pager", email: "pager@test.local" });
    for (let i = 0; i < ADMIN_EMAILS_PAGE_SIZE; i++) {
      await insertEmail(aliceId, `p${String(i).padStart(2, "0")}@test.local`);
    }
    const html = render(await load("q=p&sort=reverseemail"));
    expect(html).toContain(">Older<");
    expect(html).toContain('href="/-/admin/emails?q=p&amp;sort=reverseemail&amp;page=2"');
    expect(html).not.toContain(">Newer<"); // page 1
  });

  it("the family navbar renders the landed arms — Identity & Access open with Emails active, the Integrations group present", async () => {
    await seedBaseFixtures();
    const html = render(await load(""));
    expect(html).toContain('class="active item" href="/-/admin/emails"');
    expect(html).toContain('href="/-/admin/badges"');
    expect(html).toContain('href="/-/admin/users"');
    expect(html).toContain('href="/-/admin/applications"');
    expect(html).toContain('href="/-/admin/hooks"');
    expect(html).toContain('href="/-/admin"'); // the landed dashboard
    // The EXTERNAL AUTH W4 arm landed: the auths item LEFT the omission
    // list (specs/external-auth-sources.md §6.4 — navbar.tmpl:19's first
    // Identity & Access entry).
    expect(html).toContain('href="/-/admin/auths"');
    expect(html).toContain('href="/-/admin/notices"'); // SPEC-0018 §3.1's top-level item
    expect(html).toContain('href="/-/admin/config"'); // SPEC-0018 §3.2's Configuration group (the Summary item)
    // The tick-18 packages arm landed (the nav-fold rider): the Assets
    // group's first item renders (navbar.tmpl:34-38, the EnablePackages arm
    // armed by default).
    expect(html).toContain('href="/-/admin/packages"');
  });
});
