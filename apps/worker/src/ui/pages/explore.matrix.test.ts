/**
 * The explore pages' DEFERRED route-level matrix (pages/explore.tsx — mounted
 * since wave 9): pages-wave9.test.ts owns the landing arms (the anonymous 303,
 * the anonymous/signed-in repos scope, the keyword round-trip, the
 * newest/oldest sorts, the repos 20-per-page split, the users-page gates);
 * this file carries the arms wave 9 deferred, driven through the REAL routes
 * with the minted-session pattern (the org-blocked/public-access matrix
 * harness — repo-settings-public-access.smoke.test.tsx, 8a22db6):
 *
 *   1. the claim pin's UNCLAIMED side: /explore/code (and the deeper,
 *      topic-neighbor, and non-sitemap dotted tails) parse to null and
 *      handlesUiRoute refuses them; the trailing-slash forms canonicalize
 *      (parse side) and 301 (route side, hono's trimTrailingSlash default —
 *      the redirect target, not the slash form, carries the claim);
 *   2. the bare /explore redirect has no viewer seam (signed-in = anonymous);
 *   3. the mounted routes' method edge: no write surface — a POST misses
 *      into the plain 404 (every explore registration is GET-only);
 *   4. /explore/repos: the exact 20-row page size counted end-to-end, the
 *      keyword's FormTrim, the pager's three states (single page → absent,
 *      mid-list → Older-only, beyond-the-end → Newer-only), `?page=`
 *      clamping, and the alphabetically/reversealphabetically sorts wave 9
 *      didn't drive;
 *   5. /explore/users: the Private badge (private lists, limited does not —
 *      the visibility conditional's both arms), the pinned "Joined on" stamp,
 *      the no-location negative, the users pager (never route-tested before),
 *      the oldest/reversealphabetically sorts, and the page's viewer
 *      independence (a signed-in non-admin sees the same rows as anonymous).
 *
 * Fixture isolation: the vitest plugin isolates storage per test file, so the
 * explore92-prefixed rows here are this file's private world — idempotent by
 * slug/username lookup like every wave's fixtures.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoSettings, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { T0, uiEnv } from "../__tests__/harness";

// --- fixtures -----------------------------------------------------------------

const PAGINATION_COUNT = 21; // page size 20 → exactly one row spills to page 2

interface Explore92Fixture {
  ownerCookie: string;
}

let fixture: Explore92Fixture | null = null;

/** A row-only repository (the wave-9 posture: the explore lists read D1
 *  only, no engine content), idempotent by slug. */
async function ensureRowRepo(ownerId: number, slug: string): Promise<string> {
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.slug, slug))
    .get();
  if (existing !== undefined) return existing.id;
  const id = `r_explore92-${slug}`;
  await db.insert(repositories).values({
    id,
    storageKey: id,
    ownerNamespace: "explore92owner",
    ownerId,
    slug,
    visibility: "public",
  });
  return id;
}

async function ensureExplore92Fixtures(): Promise<Explore92Fixture> {
  if (fixture !== null) return fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // The owner (mints the signed-in arms' session), a PRIVATE-visibility user
  // (the badge + location + pinned "Joined on" row), and a LIMITED one (the
  // badge's negative arm, no location).
  for (const extra of [
    { username: "explore92owner", visibility: "public" as const, location: null, createdAt: null },
    {
      username: "explore92hidden",
      visibility: "private" as const,
      location: "Hidden Harbor",
      createdAt: new Date(T0 * 1000), // 2023-11-14T22:13:20Z → the pinned stamp
    },
    { username: "explore92limited", visibility: "limited" as const, location: null, createdAt: null },
  ]) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, extra.username))
      .get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: extra.username,
        usernameLower: extra.username,
        isAdmin: false,
        status: "active",
        visibility: extra.visibility,
        location: extra.location,
        createdAt: extra.createdAt ?? new Date(),
      });
    }
  }

  // The pagination block: 21 active public users u01..u21 — with
  // sort=alphabetically and q=explore92-u exactly 20 fit page 1.
  for (let i = 1; i <= PAGINATION_COUNT; i++) {
    const username = `explore92-u${String(i).padStart(2, "0")}`;
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username,
        usernameLower: username,
        isAdmin: false,
        status: "active",
        visibility: "public",
        location: null,
        createdAt: new Date(),
      });
    }
  }

  const owner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "explore92owner"))
    .get();
  if (owner === undefined) throw new Error("explore92 owner row missing");

  // The repos: r01..r21 (the pager block; the r-prefix keeps them
  // slug-ordered ahead of solo) + the solo row whose repo_settings carries
  // the description the batched loader read must surface.
  for (let i = 1; i <= PAGINATION_COUNT; i++) {
    await ensureRowRepo(owner.id, `explore92-r${String(i).padStart(2, "0")}`);
  }
  const soloId = await ensureRowRepo(owner.id, "explore92-solo");
  const soloSettings = await db
    .select({ repoId: repoSettings.repoId })
    .from(repoSettings)
    .where(eq(repoSettings.repoId, soloId))
    .get();
  if (soloSettings === undefined) {
    await db.insert(repoSettings).values({ repoId: soloId, description: "the solo settings description line" });
  }

  fixture = { ownerCookie: await mintSession(env.DB, owner.id) };
  return fixture;
}

beforeAll(async () => {
  await ensureExplore92Fixtures();
});

// --- the mounted-route harness (the public-access minted-session pattern) -----

/** The real production path on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

/** Occurrence count of a literal needle — the row counters below (every repo
 *  row renders exactly one pulls-counter anchor, every user row exactly one
 *  name link). */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --- the claim pin (the UNCLAIMED side — wave 9 owns the claimed literals) -----

describe("the explore claim pin's unclaimed side (parseUiRoute / handlesUiRoute)", () => {
  it("refuses /explore/code and every deeper tail — the engine/parent owns them", () => {
    expect(parseUiRoute("/explore/code")).toBeNull();
    expect(handlesUiRoute("/explore/code")).toBe(false);
    expect(parseUiRoute("/explore/code/deeper")).toBeNull();
    expect(handlesUiRoute("/explore/code/deeper")).toBe(false);
  });

  it("refuses the topic-search aux shape's unclaimed neighbors (the claimed 4-segment aux is search-aux's own pin)", () => {
    expect(parseUiRoute("/explore/topics")).toBeNull();
    expect(parseUiRoute("/explore/topics/search/extra")).toBeNull();
  });

  it("refuses non-sitemap tails under explore/repos and explore/users (the sitemap-N.xml shapes are window-2e's own pin)", () => {
    expect(parseUiRoute("/explore/repos/extra")).toBeNull();
    expect(parseUiRoute("/explore/repos/extra.xml")).toBeNull();
    expect(parseUiRoute("/explore/users/extra")).toBeNull();
  });

  it("canonicalizes the trailing-slash forms to the claimed literals (§4.13 — the parse side)", () => {
    expect(parseUiRoute("/explore/")).toEqual({ family: "explore-root" });
    expect(parseUiRoute("/explore/repos/")).toEqual({ family: "explore-repos" });
    expect(parseUiRoute("/explore/users/")).toEqual({ family: "explore-users" });
    expect(handlesUiRoute("/explore/repos/")).toBe(true);
  });
});

// --- the bare /explore redirect (no viewer seam) --------------------------------

describe("the bare /explore redirect", () => {
  it("303s onto the repos page signed-in exactly like anonymous, with an empty body", async () => {
    const { ownerCookie } = await ensureExplore92Fixtures();
    const res = await fetchUi("/explore", withCookie(ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/explore/repos");
    expect(await res.text()).toBe("");
  });
});

// --- the mounted routes' edges (GET-only surface, trailing slash, unclaimed) ----

describe("the mounted explore routes' edges", () => {
  it("404s an unclaimed /explore/code GET — never the explore shell", async () => {
    const res = await fetchUi("/explore/code");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("page-content explore");
  });

  it("301s the trailing-slash forms onto the canonical paths — claimed or not (the slash form itself never renders)", async () => {
    const repos = await fetchUi("/explore/repos/");
    expect(repos.status).toBe(301);
    expect(repos.headers.get("location")).toBe("https://test.local/explore/repos");

    const unclaimed = await fetchUi("/explore/code/");
    expect(unclaimed.status).toBe(301);
    expect(unclaimed.headers.get("location")).toBe("https://test.local/explore/code");
    expect(await unclaimed.text()).not.toContain("page-content explore"); // no laundering
  });

  it("answers a POST with the plain 404 (no write surface — every explore registration is GET-only)", async () => {
    const post = await fetchUi("/explore/repos", { method: "POST" });
    expect(post.status).toBe(404);
    expect(await post.text()).not.toContain("page-content explore");
  });
});

// --- /explore/repos — the deferred pager, keyword, and sort arms ------------------

describe("/explore/repos — pager states and the keyword's FormTrim", () => {
  it("carries exactly 20 rows on page 1 with an Older-only pager, and the spill rows on page 2 with a Newer-only one", async () => {
    const page1 = await fetchUi("/explore/repos");
    expect(page1.status).toBe(200);
    const page1Html = await page1.text();
    // 22 public rows total (r01..r21 + solo); slug order puts r01..r20 on
    // page 1 — one pulls-counter anchor per row.
    expect(countOf(page1Html, 'aria-label="Pull Requests"')).toBe(20);
    expect(page1Html).toContain('href="/explore/repos?page=2"'); // unfiltered: only ?page= travels
    expect(page1Html).toContain("<span class=\"navigation_label\">Older</span>");
    expect(page1Html).not.toContain("<span class=\"navigation_label\">Newer</span>");

    const page2 = await fetchUi("/explore/repos?page=2");
    expect(page2.status).toBe(200);
    const page2Html = await page2.text();
    expect(countOf(page2Html, 'aria-label="Pull Requests"')).toBe(2); // r21 + solo
    expect(page2Html).toContain('href="/explore92owner/explore92-r21"');
    expect(page2Html).toContain('href="/explore92owner/explore92-solo"');
    expect(page2Html).toContain('href="/explore/repos?page=1"');
    expect(page2Html).toContain("<span class=\"navigation_label\">Newer</span>");
    expect(page2Html).not.toContain("<span class=\"navigation_label\">Older</span>");
  });

  it("trims the submitted keyword (upstream FormTrim) — the trimmed value round-trips and still matches", async () => {
    const res = await fetchUi("/explore/repos?q=%20explore92-solo%20");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/explore92owner/explore92-solo"');
    expect(html).toContain('value="explore92-solo"'); // trimmed, verbatim spaces gone
    expect(html).toContain("the solo settings description line"); // the batched settings read
  });

  it("renders no pager on a single-page result", async () => {
    const res = await fetchUi("/explore/repos?q=explore92-solo");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/explore92owner/explore92-solo"');
    expect(html).not.toContain("navigation_label");
  });

  it("clamps ?page= junk and zero to 1 (parsePageNumber — never an error)", async () => {
    for (const junk of ["banana", "0"]) {
      const res = await fetchUi(`/explore/repos?q=explore92-solo&page=${junk}`);
      expect(res.status, junk).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/explore92owner/explore92-solo"'); // page 1's row
      expect(html).not.toContain("navigation_label");
    }
  });

  it("renders the beyond-the-end page as no-results with a Newer-only pager (no upper clamp)", async () => {
    const res = await fetchUi("/explore/repos?q=explore92-solo&page=99");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No matching results found.");
    expect(html).toContain('href="/explore/repos?q=explore92-solo&amp;page=98"');
    expect(html).toContain("<span class=\"navigation_label\">Newer</span>");
    expect(html).not.toContain("<span class=\"navigation_label\">Older</span>");
    expect(html).not.toContain('href="/explore92owner/explore92-solo"');
  });

  it("orders by the two remaining web sorts — alphabetically, reversealphabetically — and defaults to slug order", async () => {
    const assertOrder = (html: string, first: string, second: string): void => {
      const a = html.indexOf(`/explore92owner/explore92-${first}"`);
      const b = html.indexOf(`/explore92owner/explore92-${second}"`);
      expect(a, `${first} before ${second}`).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(-1);
      expect(a).toBeLessThan(b);
    };

    const def = await fetchUi("/explore/repos?q=explore92-r0");
    const defHtml = await def.text();
    assertOrder(defHtml, "r01", "r09"); // the service default (slug ASC)

    const alpha = await fetchUi("/explore/repos?q=explore92-r0&sort=alphabetically");
    assertOrder(await alpha.text(), "r01", "r09");

    const reverse = await fetchUi("/explore/repos?q=explore92-r0&sort=reversealphabetically");
    assertOrder(await reverse.text(), "r09", "r01");
  });
});

// --- /explore/users — the deferred badge, stamp, pager, and sort arms -------------

describe("/explore/users — the visibility badge, the joined stamp, the pager, and viewer independence", () => {
  it("badges exactly the private-visibility row — the limited row lists badgeless (both arms of the conditional)", async () => {
    // Each keyword isolates one row (1 hit ≤ the 20-slot page), so the badge
    // count is per-row exact without pager arithmetic.
    const hidden = await fetchUi("/explore/users?q=explore92hidden");
    expect(hidden.status).toBe(200);
    const hiddenHtml = await hidden.text();
    expect(hiddenHtml).toContain('href="/explore92hidden">explore92hidden</a>');
    expect(countOf(hiddenHtml, ">Private</span>")).toBe(1);
    expect(hiddenHtml).toContain("Hidden Harbor"); // the location row renders for the private user

    const limited = await fetchUi("/explore/users?q=explore92limited");
    expect(limited.status).toBe(200);
    const limitedHtml = await limited.text();
    expect(limitedHtml).toContain('href="/explore92limited">explore92limited</a>');
    expect(limitedHtml).not.toContain(">Private</span>"); // the conditional's negative arm
  });

  it("stamps Joined on from the pinned createdAt through formatDueDate's UTC month-day-year form", async () => {
    const res = await fetchUi("/explore/users?q=explore92hidden");
    const html = await res.text();
    expect(html).toContain("Joined on Nov 14, 2023"); // T0 = 2023-11-14T22:13:20Z
  });

  it("omits the location markup for a location-less row but keeps the joined line", async () => {
    const res = await fetchUi("/explore/users?q=explore92limited");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("octicon-location");
    expect(html).toContain("Joined on");
  });

  it("paginates 20-per-page with the keyword preserved, the spill row on page 2", async () => {
    const page1 = await fetchUi("/explore/users?q=explore92-u&sort=alphabetically");
    expect(page1.status).toBe(200);
    const page1Html = await page1.text();
    expect(countOf(page1Html, 'href="/explore92-u')).toBe(20); // u01..u20
    expect(page1Html).toContain('href="/explore/users?q=explore92-u&amp;page=2"');
    expect(page1Html).toContain("<span class=\"navigation_label\">Older</span>");
    expect(page1Html).not.toContain("<span class=\"navigation_label\">Newer</span>");

    const page2 = await fetchUi("/explore/users?q=explore92-u&sort=alphabetically&page=2");
    expect(page2.status).toBe(200);
    const page2Html = await page2.text();
    expect(countOf(page2Html, 'href="/explore92-u')).toBe(1); // u21 alone
    expect(page2Html).toContain('href="/explore92-u21">explore92-u21</a>');
    expect(page2Html).not.toContain('href="/explore92-u01"');
    expect(page2Html).toContain('href="/explore/users?q=explore92-u&amp;page=1"');
    expect(page2Html).toContain("<span class=\"navigation_label\">Newer</span>");
    expect(page2Html).not.toContain("<span class=\"navigation_label\">Older</span>");
  });

  it("orders by the two remaining upstream sorts — oldest and reversealphabetically (single-page keyword set)", async () => {
    const assertOrder = async (sort: string, first: string, second: string): Promise<void> => {
      // q=explore92-u0 matches u01..u09 — nine rows, one page, both ends on it.
      const res = await fetchUi(`/explore/users?q=explore92-u0&sort=${sort}`);
      const html = await res.text();
      const a = html.indexOf(`href="/explore92-${first}"`);
      const b = html.indexOf(`href="/explore92-${second}"`);
      expect(a, `${sort}: ${first} before ${second}`).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(-1);
      expect(a).toBeLessThan(b);
    };
    await assertOrder("oldest", "u01", "u09"); // id ASC
    await assertOrder("reversealphabetically", "u09", "u01"); // lower_name DESC
  });

  it("is viewer-independent: a signed-in non-admin sees a private-visibility user exactly like anonymous", async () => {
    const { ownerCookie } = await ensureExplore92Fixtures();
    const res = await fetchUi("/explore/users?q=explore92hidden", withCookie(ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/explore92hidden">explore92hidden</a>');
    expect(countOf(html, ">Private</span>")).toBe(1); // the identical badge picture
  });
});
