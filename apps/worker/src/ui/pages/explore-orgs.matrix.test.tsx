/**
 * The explore ORGANIZATIONS page's route matrix (pages/explore.tsx this
 * wave's arm — upstream org.go:17's Organizations over the shared
 * tplExploreUsers template): the mounted-route arms driven through
 * `uiRouter.fetch()` with the explore92 matrix's minted-session pattern, in
 * the file's private `explo-o` fixture world:
 *
 *   - the claim pins: the exact 3-segment literal parses, handlesUiRoute
 *     admits it, the trailing-slash form canonicalizes, and the deeper
 *     tails stay unclaimed;
 *   - the visibility ladder (org.go:31-34's switch): anonymous lists ONLY
 *     public orgs; a signed-in viewer gains the private and limited rows —
 *     each keyword isolating one org so the counts stay exact;
 *   - the row shape through the shared user-list component: the org name
 *     link, the Private badge, the location and Joined-on rows (upstream's
 *     org rows ARE user-list rows);
 *   - the keyword arms: `q=` lowercases against `lower_name` and matches
 *     `LOWER(full_name)` too (models/user/search.go:71-89's OR pair);
 *   - the sort orders (newest default = id DESC, oldest = id ASC,
 *     alphabetically/reversealphabetically on lower_name) and the
 *     garbage-sort degrade;
 *   - the pagination grammar: 21 orgs spill exactly one row to page 2, the
 *     Older/Newer hrefs keeping q;
 *   - the tab strip: the Organizations item renders on all three explore
 *     pages, active only here.
 *
 * Plain USER rows never list here (Types: [UserTypeOrganization] — the
 * users-page twin owns that gate's pin).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { T0, uiEnv } from "../__tests__/harness";

// --- fixtures -----------------------------------------------------------------

const ORG_COUNT = 21; // page size 20 → exactly one org spills to page 2

interface Fixture {
  viewerCookie: string;
}

let fixture: Fixture | null = null;

async function ensureUserRow(row: {
  username: string;
  type?: "user" | "org";
  visibility?: "public" | "limited" | "private";
  fullName?: string;
  location?: string | null;
  createdAt?: Date | null;
}): Promise<void> {
  const db = drizzle(env.DB);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, row.username)).get();
  if (existing !== undefined) return;
  await db.insert(users).values({
    username: row.username,
    usernameLower: row.username,
    isAdmin: false,
    status: "active",
    type: row.type ?? "user",
    visibility: row.visibility ?? "public",
    fullName: row.fullName ?? null,
    location: row.location ?? null,
    createdAt: row.createdAt ?? new Date(),
  });
}

async function ensureFixtures(): Promise<Fixture> {
  if (fixture !== null) return fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  // The visibility ladder's three orgs (each keyword-isolated), the
  // full_name keyword carrier, the plain user (never lists), and the
  // signed-in viewer.
  await ensureUserRow({ username: "explo-o-pub", type: "org" });
  await ensureUserRow({
    username: "explo-o-secret",
    type: "org",
    visibility: "private",
    location: "Underground",
    createdAt: new Date(T0 * 1000), // the pinned Joined-on stamp
  });
  await ensureUserRow({ username: "explo-o-gated", type: "org", visibility: "limited" });
  await ensureUserRow({ username: "explo-o-named", type: "org", fullName: "The Brochure Cooperative" });
  await ensureUserRow({ username: "explo-o-human" }); // a plain USER — never lists
  await ensureUserRow({ username: "explo-o-viewer" });

  // The pagination block: 21 public orgs explo-ob-01..explo-ob-21 — the
  // `ob` prefix keeps them disjoint from the named ladder orgs' keywords.
  for (let i = 1; i <= ORG_COUNT; i++) {
    await ensureUserRow({ username: `explo-ob-${String(i).padStart(2, "0")}`, type: "org" });
  }

  const viewer = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "explo-o-viewer")).get();
  if (viewer === undefined) throw new Error("explo-o-viewer row missing");
  fixture = { viewerCookie: await mintSession(env.DB, viewer.id) };
  return fixture;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the mounted-route harness -------------------------------------------------

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --- the claim pins -------------------------------------------------------------

describe("the /explore/organizations claim pins", () => {
  it("claims the exact literal, canonicalizes the trailing slash, and refuses deeper tails", () => {
    expect(parseUiRoute("/explore/organizations")).toEqual({ family: "explore-organizations" });
    expect(parseUiRoute("/explore/organizations/")).toEqual({ family: "explore-organizations" });
    expect(handlesUiRoute("/explore/organizations")).toBe(true);
    expect(parseUiRoute("/explore/organizations/extra")).toBeNull();
    expect(parseUiRoute("/explore/organizations/extra.xml")).toBeNull();
    expect(handlesUiRoute("/explore/organizations/extra")).toBe(false);
    // The literal binds case-sensitively (the explore92 convention).
    expect(parseUiRoute("/explore/Organizations")).toBeNull();
  });

  it("renders the page with the tab strip's Organizations item active and the users-class chrome", async () => {
    const res = await fetchUi("/explore/organizations");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content explore users"'); // the shared tplExploreUsers chrome upstream
    expect(html).toContain('<a class="active item" href="/explore/organizations">');
    expect(html).toContain('href="/explore/repos"');
    expect(html).toContain('href="/explore/users"');
    expect(html).toContain('action="/explore/organizations"');
    expect(html).toContain('placeholder="Search users…"'); // the shared user-search form
  });

  it("keeps the strip item inactive on the sibling pages", async () => {
    const repos = await fetchUi("/explore/repos");
    const reposHtml = await repos.text();
    expect(reposHtml).toContain('<a class="item" href="/explore/organizations">');
    expect(reposHtml).not.toContain('<a class="active item" href="/explore/organizations">');
    const users = await fetchUi("/explore/users?q=explo-o-human");
    expect((await users.text())).toContain('<a class="item" href="/explore/organizations">');
  });
});

// --- the visibility ladder (org.go:31-34's switch) --------------------------------

describe("the orgs visibility ladder", () => {
  it("lists ONLY the public orgs anonymously — private and limited keyword-isolated misses", async () => {
    for (const q of ["explo-o-pub", "explo-o-secret", "explo-o-gated"]) {
      const res = await fetchUi(`/explore/organizations?q=${q}`);
      expect(res.status, q).toBe(200);
      const html = await res.text();
      if (q === "explo-o-pub") {
        expect(html).toContain('href="/explo-o-pub">explo-o-pub</a>');
      } else {
        expect(html).toContain("No matching results found.");
      }
    }
  });

  it("gains the private and limited orgs for a signed-in viewer (the Visible triple)", async () => {
    const { viewerCookie } = await ensureFixtures();
    for (const q of ["explo-o-pub", "explo-o-secret", "explo-o-gated"]) {
      const res = await fetchUi(`/explore/organizations?q=${q}`, withCookie(viewerCookie));
      expect(res.status, q).toBe(200);
      expect(await res.text()).toContain(`href="/${q}">${q}</a>`);
    }
  });

  it("badges the private org and carries its location + pinned Joined-on stamp", async () => {
    const { viewerCookie } = await ensureFixtures();
    const res = await fetchUi("/explore/organizations?q=explo-o-secret", withCookie(viewerCookie));
    const html = await res.text();
    expect(countOf(html, ">Private</span>")).toBe(1);
    expect(html).toContain("Underground");
    expect(html).toContain("Joined on Nov 14, 2023"); // T0 = 2023-11-14T22:13:20Z
  });

  it("never lists plain user rows (Types: [UserTypeOrganization])", async () => {
    const res = await fetchUi("/explore/organizations?q=explo-o-human");
    expect(await res.text()).toContain("No matching results found.");
  });
});

// --- the keyword arms --------------------------------------------------------------

describe("the orgs keyword arms", () => {
  it("matches the full_name column (search.go's LOWER(full_name) OR arm)", async () => {
    const res = await fetchUi("/explore/organizations?q=Brochure");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/explo-o-named">explo-o-named</a>');
  });

  it("matches case-insensitively on the login (the instr predicate lowercases the keyword)", async () => {
    const res = await fetchUi("/explore/organizations?q=EXPLO-O-PUB");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/explo-o-pub">explo-o-pub</a>');
    expect(countOf(html, 'href="/explo-o-')).toBe(1);
  });
});

// --- the sorts ---------------------------------------------------------------------

describe("the orgs sort orders", () => {
  const orderProbe = async (query: string, first: string, second: string): Promise<void> => {
    const res = await fetchUi(`/explore/organizations?${query}`);
    const html = await res.text();
    const a = html.indexOf(`href="/explo-ob-${first}"`);
    const b = html.indexOf(`href="/explo-ob-${second}"`);
    expect(a, `${query}: ${first} before ${second}`).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  };

  it("defaults to newest (id DESC) and honors oldest (id ASC)", async () => {
    // q=explo-ob-0 matches 01..09 — nine rows, one page.
    await orderProbe("q=explo-ob-0", "09", "01"); // newest default
    await orderProbe("q=explo-ob-0&sort=oldest", "01", "09");
  });

  it("honors alphabetically and reversealphabetically on lower_name", async () => {
    await orderProbe("q=explo-ob-0&sort=alphabetically", "01", "09");
    await orderProbe("q=explo-ob-0&sort=reversealphabetically", "09", "01");
  });

  it("degrades an unknown sort to the newest default (parseExploreUserSort's default arm)", async () => {
    await orderProbe("q=explo-ob-0&sort=banana", "09", "01");
  });
});

// --- the pagination grammar ----------------------------------------------------------

describe("the orgs pagination", () => {
  it("carries exactly 20 org rows on page 1 with an Older-only pager, spilling one to page 2", async () => {
    const page1 = await fetchUi("/explore/organizations?q=explo-ob-&sort=alphabetically");
    expect(page1.status).toBe(200);
    const page1Html = await page1.text();
    expect(countOf(page1Html, 'href="/explo-ob-')).toBe(20); // 01..20
    expect(page1Html).toContain('href="/explore/organizations?q=explo-ob-&amp;page=2"');
    expect(page1Html).toContain("<span class=\"navigation_label\">Older</span>");
    expect(page1Html).not.toContain("<span class=\"navigation_label\">Newer</span>");

    const page2 = await fetchUi("/explore/organizations?q=explo-ob-&sort=alphabetically&page=2");
    expect(page2.status).toBe(200);
    const page2Html = await page2.text();
    expect(countOf(page2Html, 'href="/explo-ob-')).toBe(1); // 21 alone
    expect(page2Html).toContain('href="/explo-ob-21">explo-ob-21</a>');
    expect(page2Html).toContain('href="/explore/organizations?q=explo-ob-&amp;page=1"');
    expect(page2Html).toContain("<span class=\"navigation_label\">Newer</span>");
  });

  it("renders the beyond-the-end page as no-results with a q-keeping Newer pager", async () => {
    const res = await fetchUi("/explore/organizations?q=explo-o-pub&page=99");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No matching results found.");
    expect(html).toContain('href="/explore/organizations?q=explo-o-pub&amp;page=98"');
    expect(html).toContain("<span class=\"navigation_label\">Newer</span>");
  });
});
