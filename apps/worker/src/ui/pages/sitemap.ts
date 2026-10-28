/**
 * The sitemap family (the parity survey's M-tier remainder row) — the three
 * XML surfaces the Gitea web mux serves beside the explore pages:
 *
 *   GET /sitemap.xml                        sitemap INDEX      web.go:530,
 *                                           web.HomeSitemap (routers/web/
 *                                           home.go:47-92)
 *   GET /explore/repos/sitemap-{idx}.xml    repo urlset        web.go:554,
 *                                           explore.Repos (routers/web/
 *                                           explore/repo.go:37-47 + 118-133)
 *   GET /explore/users/sitemap-{idx}.xml    user urlset        web.go:556,
 *                                           explore.Users (routers/web/
 *                                           explore/user.go:35-45 + 97-111)
 *
 * NOTE on the survey premise: at this pin there is NO organizations
 * sub-sitemap — `/explore/organizations` exists (web.go:557) but carries no
 * `sitemap-{idx}.xml` sibling route. The index lists users sub-sitemaps
 * FIRST, then repos sub-sitemaps (home.go's HomeSitemap add order).
 *
 * ## XML contract (modules/sitemap/sitemap.go + its _test.go at the pin —
 *  byte-exact port of Go's xml.Encoder output)
 *
 * Both documents open with Go's `xml.Header` (which ends in `\n`), declare
 * the sitemaps.org 0.9 namespace, and end with a trailing `\n`:
 *
 *   <?xml version="1.0" encoding="UTF-8"?>\n
 *   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
 *     <url><loc>…</loc>[<lastmod>…</lastmod>]</url>…   (no separator text)
 *   </urlset>\n
 *
 * The index root element is `<sitemapindex …>` with `<sitemap><loc>…</loc>
 * [</sitemap>]` children instead (no lastmod — HomeSitemap adds bare URLs).
 * `lastmod` is RFC3339 UTC with second precision (`2022-04-30T12:33:28Z`),
 * OMITTED when the row has no updated stamp (the module's own "without
 * lastmod" test arm). Caps: 50000 entries per document and 50 MiB
 * (sitemap.go:15-16,64-70) — enforced here as a RangeError thrown BEFORE
 * the Response is built (documented divergence: upstream checks inside
 * WriteTo, after the 200 + Content-Type headers are already sent, and just
 * logs). Content-Type: `text/xml` exactly — HomeSitemap and both explore
 * sitemap arms set it without a charset (home.go:87, repo.go:129,
 * user.go:105); the web context middleware's zero-option prod Cache-Control
 * rides along (the diffpatch Response convention).
 *
 * ## Paging + visibility (the anonymous public view — sitemaps are public)
 *
 * - Page size `setting.UI.SitemapPagingNum` = 20 (modules/setting/ui.go:88);
 *   the index emits ceil(count/20) sub-sitemap URLs per family, `sitemap-1`
 *   first (home.go:59-66 + 74-82).
 * - repos: the landed explore read path VERBATIM — `searchExploreRepos`
 *   with a null doer carries upstream's `Private: ctx.Doer != nil` scope
 *   (web.go `Repos` → RenderRepoSearch's opts), so the anonymous sitemap
 *   sees public rows only; `?sort=` is left empty → the service's landed
 *   default order (slug ASC — search.ts's documented degradation of
 *   upstream's recentupdate default). Entries are
 *   `/{owner}/{repo}` with `lastmod` from `repositories.updated_at`
 *   (upstream `item.HTMLURL()` + `UpdatedUnix`), omitted when null.
 * - users: the landed explore read path PLUS the public-visibility ceiling.
 *   Upstream's user sitemap arm runs SearchUsers under
 *   `BuildCanSeeUserCondition(ctx.Doer)` (models/user/search.go:170-188) —
 *   for the anonymous viewer that ANDs `visibility IN (public)`, and
 *   HomeSitemap's index count pins `Visible: [VisibleTypePublic]`
 *   (home.go:51-57) besides. The landed `searchExploreUsers` predicate set
 *   (`type = 'user' AND status = 'active'` + the keyword arm — search.ts)
 *   is mirrored here with the public-visibility condition folded in, same
 *   "newest" default order (users.id DESC — the landed explore page's
 *   documented default). Entries are `/{username}`, lastmod omitted: the
 *   D1 `users` table carries no updated column (schema.ts — only
 *   `created_at`), so there is no honest `UpdatedUnix` source (the module's
 *   own nil-LastMod shape). `?sort=` is NOT honored on the sub-sitemaps —
 *   upstream's RenderUserSearch does read it, but the sitemap URL family is
 *   machine-consumed and the landed sorts are a UI concern (the same
 *   posture the explore page's degradation documents).
 * - idx parsing (upstream RenderRepoSearch/RenderUserSearch): the chi
 *   pattern `{idx}` matches ANY tail, `PathParamInt` of a non-number is 0,
 *   and `page <= 1` falls through to 1 — so `sitemap-abc.xml` serves page 1
 *   upstream. parseSitemapIdx reproduces exactly that (null only for a tail
 *   that is not the `sitemap-*.xml` shape at all — the unregistered-route
 *   404). A page past the data (idx 99 of 1 page) serves the empty urlset —
 *   upstream's empty-page arm, the module's own "empty" test byte shape.
 * - `sitemapEnabled` (web.go:423-428) 404s when
 *   `setting.Other.EnableSitemap` is false; no such setting is landed and
 *   the upstream default is true, so the family is always served here.
 * - HomeSitemap's `DisableUsersPage` gate (home.go:51): no landed setting —
 *   the upstream default (false), so the users section is always emitted.
 *
 * This module holds the loaders + the XML/Response builders only; the
 * handlers live in src/ui/index.ts beside their sibling dispatchers (the
 * resolveUiRequest prologue is index-owned) — MOUNTED at 84996c6; the
 * retired HANDOFF is the mount record at the bottom.
 */

import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { searchExploreRepos } from "../../api/services/search";
import { users } from "../../db/schema";

/** Upstream `setting.UI.SitemapPagingNum` (modules/setting/ui.go:88). */
export const SITEMAP_PAGE_SIZE = 20;

/** Upstream `urlsLimit` (modules/sitemap/sitemap.go:16). */
const SITEMAP_URLS_LIMIT = 50_000;

/** Go's `xml.Header` constant — note the trailing newline. */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Upstream `schemaURL` (modules/sitemap/sitemap.go:18). */
const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";

// ---------------------------------------------------------------------------
// XML builders (modules/sitemap/sitemap.go's WriteTo — byte-exact)
// ---------------------------------------------------------------------------

/** Chardata escaping, Go xml.Encoder's predeclared-entity set (& < > " '). */
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
}

/** RFC3339 UTC, second precision (Go time.Time XML marshaling: nanoseconds
 *  omitted when zero — the upstream test's `2022-04-30T12:33:28Z`). */
function rfc3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One `<url>`/`<sitemap>` entry. `lastmod` omitted when null. */
export interface SitemapEntry {
  loc: string;
  lastmod?: Date | null;
}

function throwOverLimit(length: number, kind: "URLs" | "sub-sitemaps"): void {
  if (length > SITEMAP_URLS_LIMIT) {
    throw new RangeError(
      `sitemap contains ${length} ${kind}, but only ${SITEMAP_URLS_LIMIT} are allowed`,
    );
  }
}

/**
 * The `<urlset>` document — the repos/users sub-sitemaps' body. Byte shape
 * per modules/sitemap/sitemap_test.go's "regular"/"without lastmod"/
 * "empty" arms.
 */
export function sitemapUrlsetXml(entries: SitemapEntry[]): string {
  throwOverLimit(entries.length, "URLs");
  const body = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `<lastmod>${rfc3339Seconds(entry.lastmod)}</lastmod>` : "";
      return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`;
    })
    .join("");
  return `${XML_HEADER}<urlset xmlns="${SITEMAP_NAMESPACE}">${body}</urlset>\n`;
}

/**
 * The `<sitemapindex>` document — the /sitemap.xml body. HomeSitemap adds
 * bare URLs (no lastmod), so this builder takes plain locations.
 */
export function sitemapIndexXml(locations: string[]): string {
  throwOverLimit(locations.length, "sub-sitemaps");
  const body = locations.map((loc) => `<sitemap><loc>${escapeXml(loc)}</loc></sitemap>`).join("");
  return `${XML_HEADER}<sitemapindex xmlns="${SITEMAP_NAMESPACE}">${body}</sitemapindex>\n`;
}

/**
 * The `sitemap-{idx}.xml` tail parser — upstream's chi `{idx}` +
 * `PathParamInt` + `page <= 1 → 1` cascade (module doc): any
 * `sitemap-*.xml` tail is accepted; a non-numeric tail serves page 1; a
 * tail without the `sitemap-` prefix at all is unregistered (null → the
 * 404 family).
 */
export function parseSitemapIdx(tail: string): number | null {
  if (!tail.startsWith("sitemap-") || !tail.endsWith(".xml")) return null;
  const middle = tail.slice("sitemap-".length, -".xml".length);
  const idx = /^\d+$/.test(middle) ? Number.parseInt(middle, 10) : 0;
  return idx >= 1 ? idx : 1;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * The public-active-individual predicate every users-side read here shares:
 * the landed explore gates (searchExploreUsers — `type = 'user' AND
 * status = 'active'`) plus the anonymous-visibility ceiling
 * `visibility = 'public'` (models/user/search.go:184's
 * BuildCanSeeUserCondition(nil) arm; home.go's Visible:[Public] count).
 */
function publicUserConditions() {
  return [eq(users.type, "user"), eq(users.status, "active"), eq(users.visibility, "public")];
}

/** The count HomeSitemap pages the users section from (home.go:51-66). */
async function countPublicUsers(d1: D1Database): Promise<number> {
  const rows = await drizzle(d1)
    .select({ value: count() })
    .from(users)
    .where(and(...publicUserConditions()));
  return Number(rows[0]?.value ?? 0);
}

/**
 * `GET /sitemap.xml` (web.HomeSitemap): the sub-sitemap URLs for
 * ceil(publicUsers/20) users pages, then ceil(publicRepos/20) repos pages —
 * the home.go add order (users first). The repo count is the landed
 * explore read's total over a null doer (upstream SearchRepository's
 * `AllPublic: true` under the anonymous actor).
 */
export async function loadHomeSitemapIndex(d1: D1Database, origin: string): Promise<string> {
  const locations: string[] = [];
  const userCount = await countPublicUsers(d1);
  for (let idx = 1; (idx - 1) * SITEMAP_PAGE_SIZE < userCount; idx++) {
    locations.push(`${origin}/explore/users/sitemap-${idx}.xml`);
  }
  const repoTotal = (
    await searchExploreRepos(d1, null, { keyword: "", page: 1, limit: 1, sort: "" })
  ).total;
  for (let idx = 1; (idx - 1) * SITEMAP_PAGE_SIZE < repoTotal; idx++) {
    locations.push(`${origin}/explore/repos/sitemap-${idx}.xml`);
  }
  return sitemapIndexXml(locations);
}

/**
 * `GET /explore/repos/sitemap-{idx}.xml` (explore.Repos' sitemap arm): the
 * page-`idx` slice of the anonymous public repo listing through the landed
 * `searchExploreRepos` (module doc — the visibility and order degradations
 * ride on that service), mapped to `/{owner}/{repo}` + the updated stamp.
 */
export async function loadReposSitemap(d1: D1Database, origin: string, idx: number): Promise<string> {
  const listing = await searchExploreRepos(d1, null, {
    keyword: "",
    page: idx,
    limit: SITEMAP_PAGE_SIZE,
    sort: "",
  });
  return sitemapUrlsetXml(
    listing.items.map((item) => ({
      loc: `${origin}/${encodeURIComponent(item.owner.username)}/${encodeURIComponent(item.repo.slug)}`,
      lastmod: item.repo.updatedAt,
    })),
  );
}

/**
 * `GET /explore/users/sitemap-{idx}.xml` (explore.Users' sitemap arm): the
 * page-`idx` slice of the public users listing (the publicUserConditions
 * predicate, id DESC), mapped to `/{username}` with no lastmod (module doc
 * — no D1 updated column).
 */
export async function loadUsersSitemap(d1: D1Database, origin: string, idx: number): Promise<string> {
  const rows = await drizzle(d1)
    .select({ username: users.username })
    .from(users)
    .where(and(...publicUserConditions()))
    .orderBy(desc(users.id))
    .limit(SITEMAP_PAGE_SIZE)
    .offset((idx - 1) * SITEMAP_PAGE_SIZE);
  return sitemapUrlsetXml(rows.map((row) => ({ loc: `${origin}/${encodeURIComponent(row.username)}` })));
}

// ---------------------------------------------------------------------------
// Response + mount record
// ---------------------------------------------------------------------------

/**
 * The sitemap Response — upstream's explicit `text/xml` (no charset; the
 * three handlers each set it) over the web context middleware's zero-option
 * prod Cache-Control (the diffPatchTextResponse convention).
 */
export function sitemapXmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/xml",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

/**
 * MOUNTED at 84996c6 (window-2e A — the wiring HANDOFF is retired). All
 * three routes are GET, claimed as EXACT literal shapes in
 * `parseUiRoute` BEFORE the owner/repo parse (the explore-family precedent —
 * otherwise `/explore/repos/sitemap-1.xml` reads as owner `explore`), and
 * dispatched beside the explore arms, exactly per the recipe: the
 * `home-sitemap` / `explore-repos-sitemap` / `explore-users-sitemap`
 * families (the non-sitemap tail under /explore/{repos|users} stays
 * unclaimed → 404), each dispatch arm answering
 * `sitemapXmlResponse(await load…(c.env.DB, origin, idx))`.
 *
 * Upstream gates the family behind `sitemapEnabled` (web.go:423-428) and
 * `optExploreSignIn` on the index (web.go:530 — a signed-in viewer's index
 * could count their own private rows into the page count; the anonymous
 * count is the safe public ceiling, so no session gate is needed here).
 */
