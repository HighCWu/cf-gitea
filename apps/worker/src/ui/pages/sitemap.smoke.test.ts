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
