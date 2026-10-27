/**
 * Sitemap smoke — PORT-FIRST gates: ONE happy-path smoke per surface (the
 * index + the two sub-sitemaps over real seeded D1 rows), with the private
 * exclusion asserted (sitemaps are public — the anonymous ceiling is the
 * whole point of the family). No error-arm matrix (the polish wave owns
 * it — the module doc carries those cites).
 *
 *   1. GET /sitemap.xml (HomeSitemap) → the users-then-repos sitemapindex
 *      over 1 public user + 1 public repo, private rows invisible.
 *   2. GET /explore/repos/sitemap-1.xml → the public repo's
 *      `<url><loc>…</loc><lastmod>…</lastmod></url>` byte shape, the
 *      private repo loc ABSENT.
 *   3. GET /explore/users/sitemap-1.xml → the public user's
 *      `<url><loc>…</loc></url>` byte shape (no lastmod — no D1 updated
 *      column), the private-visibility user loc ABSENT.
 *
 * Harness posture: the module functions driven DIRECTLY (the
 * search-aux smoke convention — the route arms are index-owned; the module
 * doc's HANDOFF section carries the mount recipe), against the real workerd
 * D1 binding.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { RepoService } from "../../repos/service";
import { repositories, users } from "../../db/schema";
import {
  loadHomeSitemapIndex,
  loadReposSitemap,
  loadUsersSitemap,
  parseSitemapIdx,
  sitemapIndexXml,
  sitemapUrlsetXml,
  type SitemapEntry,
  sitemapXmlResponse,
} from "./sitemap";

// --- fixtures -----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch
const ORIGIN = "https://smoke.test";

const PUBLIC_USER = "smoke-sitemapper";
const PRIVATE_USER = "smoke-shadow"; // users.visibility = 'private'

/** Idempotent seed: the public user, the private-visibility user, the
 *  public repo (updated_at pinned to T0 — the lastmod arm) and the private
 *  repo (both D1-only — the sitemap reads listings, not engine refs). */
async function ensureSmokeFixture(): Promise<void> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  for (const [username, visibility] of [
    [PUBLIC_USER, "public"],
    [PRIVATE_USER, "private"],
  ] as const) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, username))
      .get();
    if (existing === undefined) {
      await db.insert(users).values({
        username,
        usernameLower: username,
        status: "active",
        visibility,
        createdAt: new Date(T0 * 1000),
      });
    }
  }

  const owner = await db
    .select({ id: users.id, usernameLower: users.usernameLower })
    .from(users)
    .where(eq(users.usernameLower, PUBLIC_USER))
    .get();
  if (owner === undefined) throw new Error("public user row missing");

  for (const [slug, isPrivate, updatedAt] of [
    ["public-smoke", false, new Date(T0 * 1000)],
    ["private-smoke", true, null],
  ] as const) {
    const existing = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, PUBLIC_USER), eq(repositories.slug, slug)))
      .get();
    if (existing === undefined) {
      const created = await new RepoService(env.DB).create({
        owner: { id: owner.id, usernameLower: owner.usernameLower },
        name: slug,
        isPrivate,
        status: "ready",
      });
      if (updatedAt !== null) {
        // The lifecycle service sets updated_at explicitly on writes; the
        // pin here gives the public repo its lastmod stamp.
        await db.update(repositories).set({ updatedAt }).where(eq(repositories.id, created.id));
      }
    }
  }
}

let seeded = false;

beforeAll(async () => {
  await ensureSmokeFixture();
  seeded = true;
});

// --- surface 1: GET /sitemap.xml ----------------------------------------------

describe("GET /sitemap.xml (HomeSitemap) — smoke", () => {
  it("serves the users-then-repos sitemapindex over the public rows only", async () => {
    const body = await loadHomeSitemapIndex(env.DB, ORIGIN);
    expect(body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        `<sitemap><loc>${ORIGIN}/explore/users/sitemap-1.xml</loc></sitemap>` +
        `<sitemap><loc>${ORIGIN}/explore/repos/sitemap-1.xml</loc></sitemap>` +
        "</sitemapindex>\n",
    );
    const res = sitemapXmlResponse(body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });
});

// --- surface 2: GET /explore/repos/sitemap-1.xml ------------------------------

describe("GET /explore/repos/sitemap-1.xml (explore.Repos sitemap arm) — smoke", () => {
  it("lists the public repo with its lastmod and excludes the private row", async () => {
    expect(seeded).toBe(true);
    const idx = parseSitemapIdx("sitemap-1.xml"); // the mount recipe's parse
    if (idx === null) throw new Error("idx parse failed");
    const body = await loadReposSitemap(env.DB, ORIGIN, idx);
    expect(body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        `<url><loc>${ORIGIN}/${PUBLIC_USER}/public-smoke</loc>` +
        "<lastmod>2023-11-14T22:13:20Z</lastmod></url>" +
        "</urlset>\n",
    );
    expect(body).not.toContain("private-smoke"); // the anonymous ceiling
  });
});

// --- surface 3: GET /explore/users/sitemap-1.xml ------------------------------

describe("GET /explore/users/sitemap-1.xml (explore.Users sitemap arm) — smoke", () => {
  it("lists the public user without lastmod and excludes the private-visibility row", async () => {
    expect(seeded).toBe(true);
    const idx = parseSitemapIdx("sitemap-1.xml");
    if (idx === null) throw new Error("idx parse failed");
    const body = await loadUsersSitemap(env.DB, ORIGIN, idx);
    expect(body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        `<url><loc>${ORIGIN}/${PUBLIC_USER}</loc></url>` +
        "</urlset>\n",
    );
    expect(body).not.toContain(PRIVATE_USER); // BuildCanSeeUserCondition(nil)
  });
});

// ---------------------------------------------------------------------------------
// The polish-wave deepening: the empty state, the index paging grammar, the
// entry grammar, and the caps — the module doc's error-arm matrix (the smoke
// header's deferred block), driven against the same real-D1 + pure-builder
// split. The data-driven block wipes the sitemap-visible tables and RESTORES
// the smoke fixture afterwards, so the file stays self-consistent.
// ---------------------------------------------------------------------------------

/** Tables the sitemap's reads (and the fixture's RepoService.create) touch,
 *  children first — the org-home matrix's cleanup-list convention. */
const SITEMAP_TABLES = ["repo_counters", "repo_settings", "repo_redirects", "repositories", "users"];

/** Batch-insert `n` public active users (the pagination arm's rows). */
async function seedPublicUsers(n: number, base: number): Promise<void> {
  const db = drizzle(env.DB);
  for (let index = 0; index < n; index++) {
    const username = `paging-user-${String(index).padStart(2, "0")}`;
    await db.insert(users).values({
      username,
      usernameLower: username,
      status: "active",
      visibility: "public",
      createdAt: new Date(T0 * 1000 + base + index),
    });
  }
}

describe("the empty state and the index paging grammar (the polish wave)", () => {
  it("serves the bare empty documents over zero public rows — the module's own 'empty' byte shape", async () => {
    for (const table of SITEMAP_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }

    // The index: zero public users AND zero public repos → no sub-sitemap
    // children at all (HomeSitemap's loops never fire).
    expect(await loadHomeSitemapIndex(env.DB, ORIGIN)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "</sitemapindex>\n",
    );
    // Both sub-sitemaps on page 1: the empty `<urlset>` (sitemap_test.go's
    // "empty" arm), never an error status.
    const emptyUrlset =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      "</urlset>\n";
    expect(await loadReposSitemap(env.DB, ORIGIN, 1)).toBe(emptyUrlset);
    expect(await loadUsersSitemap(env.DB, ORIGIN, 1)).toBe(emptyUrlset);

    // Restore the smoke fixture so the file stays self-consistent.
    await ensureSmokeFixture();
  });

  it("pages the users section: 21 public rows → TWO users sub-sitemaps, users FIRST, then the repos pages", async () => {
    // home.go's add order + the ceil(count/20) grammar (ui.go:88): 21 →
    // sitemap-1 and sitemap-2; zero repos → no repos pages at all.
    for (const table of SITEMAP_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await seedPublicUsers(21, 0);

    expect(await loadHomeSitemapIndex(env.DB, ORIGIN)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        `<sitemap><loc>${ORIGIN}/explore/users/sitemap-1.xml</loc></sitemap>` +
        `<sitemap><loc>${ORIGIN}/explore/users/sitemap-2.xml</loc></sitemap>` +
        "</sitemapindex>\n",
    );

    // Page 1 carries the newest 20 (users.id DESC), page 2 exactly the 21st.
    const page1 = await loadUsersSitemap(env.DB, ORIGIN, 1);
    expect(page1.split("<url>")).toHaveLength(21); // header + 20 entries
    const page2 = await loadUsersSitemap(env.DB, ORIGIN, 2);
    expect(page2).toContain("<loc>https://smoke.test/paging-user-00</loc>"); // id DESC: the first seed
    expect(page2.split("<url>")).toHaveLength(2); // header + the single overflow entry

    // Restore the smoke fixture so the file stays self-consistent.
    await ensureSmokeFixture();
  });
});

describe("parseSitemapIdx — the chi tail grammar (the polish wave)", () => {
  it("accepts any sitemap-*.xml tail; non-numeric and sub-1 folds serve page 1; other tails are unregistered", () => {
    expect(parseSitemapIdx("sitemap-1.xml")).toBe(1);
    expect(parseSitemapIdx("sitemap-2.xml")).toBe(2);
    expect(parseSitemapIdx("sitemap-99.xml")).toBe(99); // past-data pages serve the empty urlset
    expect(parseSitemapIdx("sitemap-abc.xml")).toBe(1); // PathParamInt(non-number) = 0 → 1
    expect(parseSitemapIdx("sitemap-0.xml")).toBe(1); // page <= 1 folds to 1
    expect(parseSitemapIdx("sitemap-.xml")).toBe(1); // empty middle: not digits → 0 → 1
    expect(parseSitemapIdx("sitemap--3.xml")).toBe(1); // signed tails are not digits → 0 → 1
    // A tail without the sitemap-*.xml shape at all is an unregistered route.
    expect(parseSitemapIdx("index.xml")).toBeNull();
    expect(parseSitemapIdx("sitemap-1.txt")).toBeNull();
    expect(parseSitemapIdx("sitemap.xml")).toBeNull();
  });
});

describe("the entry grammar and the 50000-entry caps (the Go xml.Encoder port)", () => {
  it("escapes chardata with Go's predeclared-entity set and stamps lastmod at second precision", () => {
    const entries: SitemapEntry[] = [
      { loc: "/a&b<c>d\"e'f" },
      { loc: "/x", lastmod: new Date(1_700_000_000_500) }, // .500Z — second precision strips it
      { loc: "/y", lastmod: null }, // the "without lastmod" arm: the element is OMITTED
    ];
    const body = sitemapUrlsetXml(entries);
    expect(body).toContain("<loc>/a&amp;b&lt;c&gt;d&#34;e&#39;f</loc>");
    expect(body).toContain("<url><loc>/x</loc><lastmod>2023-11-14T22:13:20Z</lastmod></url>");
    // The null-lastmod entry omits the element entirely (the exact /y shape).
    expect(body).toContain("<url><loc>/y</loc></url>");
    // The index builder escapes too (HomeSitemap adds bare URLs, no lastmod).
    expect(sitemapIndexXml(["/a&b", "/c"])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "<sitemap><loc>/a&amp;b</loc></sitemap>" +
        "<sitemap><loc>/c</loc></sitemap>" +
        "</sitemapindex>\n",
    );
  });

  it("throws the RangeError BEFORE the body builds past the caps; 50000 is the inclusive boundary", () => {
    const entry: SitemapEntry = { loc: "/x" };
    expect(() => sitemapUrlsetXml(Array.from({ length: 50_001 }, () => entry))).toThrow(RangeError);
    expect(() => sitemapUrlsetXml(Array.from({ length: 50_001 }, () => entry))).toThrow(/only 50000/);
    expect(() => sitemapIndexXml(Array.from({ length: 50_001 }, () => "/x"))).toThrow(/sub-sitemaps/);
    // urlsLimit is exclusive ABOVE 50000 — the boundary value builds.
    expect(() => sitemapUrlsetXml(Array.from({ length: 50_000 }, () => entry))).not.toThrow();
    expect(() => sitemapIndexXml(Array.from({ length: 50_000 }, () => "/x"))).not.toThrow();
  });
});
