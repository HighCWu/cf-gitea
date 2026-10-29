/**
 * The ADMIN ORGANIZATIONS list page's matrix (the module is UNMOUNTED — the
 * mounted route posture cannot be tested; the activity-feeds.matrix harness
 * drives the module's load+render seams over real D1, generated migrations in
 * beforeAll, hono/jsx renderToString).
 *
 * Covered here:
 *   - the LOADER's gates: the type gate (ONLY org rows surface — upstream's
 *     organization Types, orgs.go:29; plain users never do), the keyword pair
 *     (username/full name — SearchByEmail is NOT set on this page), the
 *     derived Teams/Repos counters (GROUP BY over the page's ids — no
 *     maintained columns exist, the module header) beside the maintained
 *     numMembers, the six sorts, and the 50-per-page pagination;
 *   - the RENDER's contract: the `admin user` pageClass (org/list.tmpl:1's
 *     upstream copy-through quirk, kept verbatim), the panel header + total,
 *     the LIVE New Organization button (/org/create is landed), the row
 *     projection (the fullName parens, the gold octicon-lock on a private
 *     org, the counters, the LIVE /org/{name}/settings pencil), the
 *     no-results row, the pager hrefs.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  ADMIN_ORGS_PAGE_SIZE,
  AdminOrgsPage,
  adminOrgsLocale,
  loadAdminOrgsData,
} from "./admin-orgs";

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
 *  wiring wave's posture; the module trusts its inputs. */
const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

interface OrgInsert {
  username: string;
  fullName?: string;
  visibility?: "public" | "limited" | "private";
  numMembers?: number;
  createdAt?: number;
}

async function insertOrg(insert: OrgInsert): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, full_name, display_name, type, visibility, num_members, created_at) " +
      "VALUES (?, ?, ?, ?, 'org', ?, ?, ?)",
  )
    .bind(
      insert.username,
      insert.username.toLowerCase(),
      insert.fullName ?? null,
      insert.username,
      insert.visibility ?? "public",
      insert.numMembers ?? 0,
      insert.createdAt ?? T0,
    )
    .run();
  return result.meta.last_row_id;
}

/** The standard fixture set: two public orgs (one with teams + repos +
 *  members), one private org, one plain user (never surfaces). */
async function seedBaseFixtures(): Promise<void> {
  const alphaId = await insertOrg({ username: "alpha", fullName: "Alpha Group", numMembers: 3 });
  const betaId = await insertOrg({ username: "beta", fullName: "Beta Collective", numMembers: 1, createdAt: T0 + 100 });
  await insertOrg({ username: "secret", visibility: "private", numMembers: 2 });
  await env.DB.prepare("INSERT INTO users (username, username_lower, display_name, type, created_at) VALUES ('alice', 'alice', 'Alice', 'user', unixepoch())").run();

  await env.DB.prepare("INSERT INTO teams (org_id, lower_name, name) VALUES (?, 'devs', 'Devs'), (?, 'ops', 'Ops')")
    .bind(alphaId, alphaId)
    .run();
  await env.DB.prepare("INSERT INTO teams (org_id, lower_name, name) VALUES (?, 'devs', 'Devs')").bind(betaId).run();

  for (const [id, owner, ownerId, slug] of [
    ["1", "alpha", alphaId, "one"],
    ["2", "alpha", alphaId, "two"],
    ["3", "beta", betaId, "three"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, created_at) VALUES (?, ?, ?, ?, ?, 'public', unixepoch())",
    )
      .bind(id, `r_${id}`, owner, ownerId, slug)
      .run();
  }
}

async function load(search: string): Promise<Awaited<ReturnType<typeof loadAdminOrgsData>>> {
  return loadAdminOrgsData(env.DB, new URLSearchParams(search));
}

function render(data: Awaited<ReturnType<typeof loadAdminOrgsData>>): string {
  return renderToString(<AdminOrgsPage ctx={ctx} data={data} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["users", "sessions", "teams", "team_members", "org_members", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader -----------------------------------------------------------------

describe("loadAdminOrgsData — the gates + the derived counters", () => {
  it("lists ONLY org rows — plain users never surface (the organization Types, orgs.go:29)", async () => {
    await seedBaseFixtures();
    const data = await load("");
    expect(data.total).toBe(3);
    expect(data.items.map((row) => row.org.username).sort()).toEqual(["alpha", "beta", "secret"]);
  });

  it("the keyword matches username and full name (NO email arm — SearchByEmail is not set)", async () => {
    await seedBaseFixtures();
    expect((await load("q=alpha")).items.map((row) => row.org.username)).toEqual(["alpha"]);
    expect((await load("q=collective")).items.map((row) => row.org.username)).toEqual(["beta"]);
    expect((await load("q=alice")).total).toBe(0); // a user is not an org match
  });

  it("Teams/Repos are derived per page (GROUP BY); Members rides the maintained numMembers", async () => {
    await seedBaseFixtures();
    const data = await load("");
    const byName = new Map(data.items.map((row) => [row.org.username, row]));
    expect(byName.get("alpha")?.numTeams).toBe(2);
    expect(byName.get("alpha")?.numRepos).toBe(2);
    expect(byName.get("beta")?.numTeams).toBe(1);
    expect(byName.get("beta")?.numRepos).toBe(1);
    expect(byName.get("alpha")?.org.numMembers).toBe(3);
    expect(byName.get("secret")?.numTeams).toBe(0);
    expect(byName.get("secret")?.numRepos).toBe(0);
  });

  it("all three visibilities are in scope (orgs.go:33) — the private org lists, the admin gate is the route's", async () => {
    await seedBaseFixtures();
    const data = await load("");
    expect(data.items.some((row) => row.org.visibility === "private")).toBe(true);
  });

  it("orders by the six sorts; the default is alphabetically and junk folds onto it", async () => {
    await seedBaseFixtures();
    await insertOrg({ username: "zsort", createdAt: T0 });
    await insertOrg({ username: "asort", createdAt: T0 + 500 });
    // The keyword narrows to the pair so the order assertions stay exact.
    const names = async (search: string): Promise<string[]> =>
      (await load(`q=sort&${search}`)).items.map((row) => row.org.username);

    expect(await names("")).toEqual(["asort", "zsort"]); // the default (alphabetically)
    expect(await names("sort=oldest")).toEqual(["zsort", "asort"]);
    expect(await names("sort=newest")).toEqual(["asort", "zsort"]);
    expect(await names("sort=recentupdate")).toEqual(["asort", "zsort"]);
    expect(await names("sort=leastupdate")).toEqual(["zsort", "asort"]);
    expect(await names("sort=lastlogin")).toEqual(["asort", "zsort"]); // junk → the fold
  });

  it("paginates 50 per page (Admin.OrgPagingNum); the pager query carries q + sort, never page", async () => {
    for (let i = 0; i < ADMIN_ORGS_PAGE_SIZE + 1; i++) {
      await insertOrg({ username: `org-${String(i).padStart(2, "0")}` });
    }
    const page1 = await load("");
    expect(page1.items).toHaveLength(ADMIN_ORGS_PAGE_SIZE);
    expect(page1.more).toBe(true);
    expect((await load("page=2")).items).toHaveLength(1);

    const filtered = await load("q=org&sort=newest");
    expect(filtered.query.get("q")).toBe("org");
    expect(filtered.query.get("sort")).toBe("newest");
    expect(filtered.query.has("page")).toBe(false);
    expect((await load("sort=alphabetically")).query.has("sort")).toBe(false);
  });
});

// --- the render -------------------------------------------------------------------

describe("the admin orgs DOM (templates/admin/org/list.tmpl at the pin)", () => {
  it("renders the pageClass quirk, the panel header + total, and the LIVE New Organization button", async () => {
    await seedBaseFixtures();
    const html = render(await load(""));
    expect(html).toContain('class="page-content admin user"'); // org/list.tmpl:1's literal — the upstream copy-through quirk
    // The header's text node sits before the right-floated button div
    // (list.tmpl:4-7).
    expect(html).toContain(`>${adminOrgsLocale.org_manage_panel} (${adminOrgsLocale.total.replace("%d", "3")})`);
    expect(html).toContain('<a class="ui primary tiny button" href="/org/create">'); // landed — LIVE (the module header)
    expect(html).toContain(adminOrgsLocale.new_orga);
  });

  it("renders the row projection — name link, fullName parens, the gold lock on the private org, the counters", async () => {
    await seedBaseFixtures();
    const html = render(await load(""));
    expect(html).toContain('<a href="/alpha">alpha</a>');
    expect(html).toContain('<span class="username-fullname">(Alpha Group)</span>');
    expect(html).toContain('<span class="tw-text-gold"><svg'); // the private org's lock (embedded bytes)
    expect(html).toContain("octicon-lock");
    expect(html.split("<td>2</td>").length - 1).toBeGreaterThanOrEqual(1); // alpha's teams/repos counters
    expect(html).toContain('<a href="/org/alpha/settings"'); // the LIVE settings pencil
    expect(html).toContain("octicon-pencil");
  });

  it("renders the search form, the plain-link sort menu with the active item, and the no-results row", async () => {
    await seedBaseFixtures();
    const sorted = render(await load("q=a&sort=oldest"));
    expect(sorted).toContain('action="/-/admin/orgs"');
    expect(sorted).toContain('name="q" value="a"');
    // The plain-link sort menu keeps q and marks the active item (the
    // orgs template's own `?sort=…&q=…` link shape).
    expect(sorted).toContain('class="active item" href="/-/admin/orgs?q=a&amp;sort=oldest"');

    const empty = render(await load("q=nobody"));
    expect(empty).toContain(adminOrgsLocale.no_results);
  });

  it("renders the sortable headers as links (ID/Name/Created) with the default-column arrow", async () => {
    await seedBaseFixtures();
    const plain = render(await load(""));
    expect(plain).toContain('href="/-/admin/orgs?sort=oldest"'); // the ID header's toggle
    expect(plain).toContain('href="/-/admin/orgs?sort=reversealphabetically"'); // the Name header's toggle
    expect(plain).toContain('href="/-/admin/orgs?sort=recentupdate"'); // the Created header's toggle (list.tmpl:43)
    expect(plain.split("octicon-triangle-down").length - 1).toBe(1); // the Name column's default arrow only
  });

  it("renders the pager href carrying q + sort", async () => {
    for (let i = 0; i < ADMIN_ORGS_PAGE_SIZE + 1; i++) {
      await insertOrg({ username: `org-${String(i).padStart(2, "0")}` });
    }
    const html = render(await load("sort=newest"));
    expect(html).toContain(">Older<");
    expect(html).toContain('href="/-/admin/orgs?sort=newest&amp;page=2"');
  });

  it("renders the family navbar with Organizations active and nothing unlanded", async () => {
    await seedBaseFixtures();
    const html = render(await load(""));
    expect(html).toContain('class="active item" href="/-/admin/orgs"');
    expect(html).toContain('href="/-/admin/users"');
    // The census R18 arms landed (the nav fold wave): the four new items.
    expect(html).toContain('href="/-/admin/badges"');
    expect(html).toContain('href="/-/admin/emails"');
    expect(html).toContain('href="/-/admin/applications"');
    expect(html).toContain('href="/-/admin/hooks"');
    expect(html).not.toContain("/-/admin/auths");
    expect(html).not.toContain("/-/admin/self_check");
    expect(html).toContain('href="/-/admin/notices"'); // SPEC-0018 §3.1's top-level item
    expect(html).not.toContain("/-/admin/config");
    expect(html).not.toContain("/-/admin/packages");
    expect(html).not.toContain("/-/admin/actions");
  });
});
