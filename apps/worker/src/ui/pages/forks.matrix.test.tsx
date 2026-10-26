/**
 * The forks/stars/watchers trio's DEFERRED route-level matrix (pages/
 * repo-social.tsx mounted through uiRouter — the wave-24 route tests in
 * ui/__tests__/pages-wave24.test.ts own the base arms: the parser tuples,
 * the anonymous forks list with the private-fork hiding, the owner's own
 * private-fork render, the tplWatchers discriminator on the stars page, the
 * watchers listing, the unknown-repo/deeper-tail 404s and the trio's a11y
 * smoke; ui/__tests__/pages-wave26.test.ts owns the forks page's Fork entry
 * button and the whole /fork create form). THIS FILE adds the arms those
 * suites do not carry, driven over the mounted uiRouter on the commits
 * matrix's (188f33d) minted-session pattern —
 *
 *   - the §2.5 route gates wave24 never exercised (its trio repos were all
 *     public): a PRIVATE source repo 404-shells all three families for
 *     anonymous and signed-in-stranger viewers with no repo context in the
 *     shell, while the owner and the site admin render 200 — plus the
 *     stars/watchers halves of the unknown-repo 404 (wave24 pinned the forks
 *     one only);
 *   - the fork-row shape arms beyond wave24's link-presence checks: the
 *     batched description read, the Archived / Private / Internal (the
 *     private-VISIBILITY owner) label arms bound to their rows, the
 *     trailing stars + open-pulls counts (num_stars and
 *     num_pulls − num_closed_pulls, clamped at zero), the Updated
 *     relative-time line and its null-updated absence, and the two
 *     accessible-condition arms wave24's fixture could not isolate — the
 *     site admin seeing another user's private fork (the isAdmin drop) and
 *     the signed-in stranger NOT seeing it;
 *   - the user-card shape arms (user_cards.tmpl): the joined-on fallback,
 *     the DisplayNameWithFullName rendering, the http(s) website anchor, and
 *     the non-http(s) website neutralization falling through to the
 *     location arm (the ZgotmplZ parity);
 *   - the pagination the trio never had tests for: the 40-row ItemsPerPage
 *     page over 41 forks (page 1 + Older, page 2 = the remainder + the Newer
 *     link dropping the page param), the ?page clamps (non-numeric, zero,
 *     past-the-end rendering the empty arm beside the Newer pager), and the
 *     stargazers pager with per-user identity across pages (the services'
 *     users.id order);
 *   - the empty arms: the trio answers a D1-only repo with 200s (no
 *     MustBeNotEmpty gate — the tags family's differential): the forks
 *     no-results text, the bare empty user-card uls;
 *   - the claim pins wave24 left open: the literals' case-sensitivity, the
 *     /{owner}/forks two-segment shape being the REPO HOME of a repo named
 *     "forks" (and the trio claiming its own tails over that repo), the
 *     owner/repo percent-decode arms + the malformed-encoding refusal, the
 *     watchers deep tail, and the trailing-slash 301 canonicalization at the
 *     sub-app seam (§4.13);
 *   - and the follow/star/watch action arms: NOT LANDED at this pin — no
 *     UI route claims upstream web.go's Action POSTs (`/action/{action}`) or
 *     any write on the trio literals (the module doc's data-fetch-trigger
 *     reduction), so the matrix pins the negative: POSTs onto the trio
 *     literals and the /action/star literal answer 404 through the router
 *     and mutate nothing.
 *
 * Fixture posture: a disjoint `fsx-*` family (wave24 owns wave24-*, the
 * commits matrix cm*), D1-only rows through the landed services — none of
 * the trio's reads touch the git engine, so no pack is pushed; sessions
 * minted PER REQUEST (the value never asserted).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { starRepo } from "../../api/services/stars";
import { watchRepo } from "../../api/services/repo-watchers";
import { repositories, stars, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- the minted-session route harness (the commits 188f33d pattern) -------------

const ORIGIN = "https://test.local";

/** Synthetic manifest shaped like the real Vite output (deterministic, no
 *  build dependence — the shared fixture shape). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  loadRepoSocialData → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so any waitUntil settles. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** Anonymous GET (name omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  if (as === undefined) return fetchUi(path);
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, as)).get();
  if (user === undefined) throw new Error(`fixture user missing: ${as}`);
  return fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}` } });
}

/** A signed-in same-origin form POST (the write-probe shape — nothing
 *  claims these paths, so the origin/cookie pairing only proves a valid
 *  session still cannot write through them). */
async function post(path: string, body: Record<string, string>, as: string): Promise<Response> {
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, as)).get();
  if (row === undefined) throw new Error(`fixture user missing: ${as}`);
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, row.id)}`,
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** Fork-row count: `<div class="item">` is ForkListItem's root — the shell's
 *  `class="item"` entries are anchors/forms, never divs. */
function forkRowCount(html: string): number {
  return (html.match(/<div class="item">/g) ?? []).length;
}

/** One fork row's chunk: everything between its root div and the next row's. */
function forkRow(html: string, repoHref: string): string {
  const chunk = html.split('<div class="item">').find((part) => part.includes(`href="${repoHref}"`));
  if (chunk === undefined) throw new Error(`fork row missing for ${repoHref}`);
  return chunk;
}

/** User-card count + one card's chunk (the `li.item.ui.segment` roots). */
function cardRowCount(html: string): number {
  return (html.match(/<li class="item ui segment">/g) ?? []).length;
}

function cardRow(html: string, userHref: string): string {
  const chunk = html.split('<li class="item ui segment">').find((part) => part.includes(`href="${userHref}"`));
  if (chunk === undefined) throw new Error(`user card missing for ${userHref}`);
  return chunk;
}

/** D1 side-counts (the write-probe mutation checks). */
async function countStars(repoId: string): Promise<number> {
  const row = await drizzle(env.DB).select({ n: sql<number>`count(*)` }).from(stars).where(eq(stars.repoId, repoId)).get();
  return row?.n ?? 0;
}
async function countForkRows(parentId: string): Promise<number> {
  const row = await drizzle(env.DB)
    .select({ n: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.forkParent, parentId))
    .get();
  return row?.n ?? 0;
}

// --- fixtures -----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000);

interface FsxFixture {
  paintId: string; // the social hub (forks/stars/watchers all seeded)
  bulkId: string; // the 41-fork pagination repo
  blankId: string; // the empty-arms repo
  forksRepoId: string; // the repo literally named "forks" (the shadow pin)
}

let fsxFixture: FsxFixture | null = null;

/**
 * Seed the disjoint fsx family once. Relations: fsx-owner owns every repo;
 * fsx-pal is the signed-in stranger owning paint's one PRIVATE fork;
 * fsx-root is the site admin; fsx-quiet is a private-VISIBILITY user owning
 * a public fork (the Internal label arm); fsx-g01..g45 are the stargazers
 * (g01 joined-on plain, g02 fullName, g03 https website, g04 a javascript:
 * website neutralized into the location arm, g05/g06 also watchers).
 */
async function ensureFixtures(): Promise<FsxFixture> {
  if (fsxFixture !== null) return fsxFixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  const owner = await seedVerifiedUser({ username: "fsx-owner" });
  const pal = await seedVerifiedUser({ username: "fsx-pal" });
  await seedVerifiedUser({ username: "fsx-root", isAdmin: true });
  const quiet = await seedVerifiedUser({ username: "fsx-quiet" });
  const gaz = [] as Array<{ id: number; username: string }>;
  for (let i = 1; i <= 45; i++) {
    gaz.push(await seedVerifiedUser({ username: `fsx-g${String(i).padStart(2, "0")}` }));
  }
  const gazAt = (i: number): { id: number; username: string } => gaz[i] as { id: number; username: string };
  // The card-meta arms ride the users table directly (seedVerifiedUser has no
  // profile input).
  await db.update(users).set({ fullName: "Peak Two" }).where(eq(users.id, gazAt(1).id));
  await db.update(users).set({ website: "https://g03.example.com" }).where(eq(users.id, gazAt(2).id));
  await db.update(users).set({ website: "javascript:alert(1)", location: "The Void" }).where(eq(users.id, gazAt(3).id));
  await db.update(users).set({ visibility: "private" }).where(eq(users.id, quiet.id));

  const service = new RepoService(env.DB);
  const mk = async (slug: string, opts: { isPrivate?: boolean } = {}): Promise<string> => {
    const row = await service.create({
      owner: { id: owner.id, usernameLower: "fsx-owner" },
      name: slug,
      isPrivate: opts.isPrivate ?? false,
      status: "ready",
    });
    return row.id;
  };

  const paintId = await mk("paint");
  await mk("vault", { isPrivate: true }); // the gates repo (no rows seeded on it)
  const bulkId = await mk("bulk");
  const blankId = await mk("blank");
  const forksRepoId = await mk("forks"); // the shadow pin's repo

  // paint's shape forks: four owned by the owner (one per shape arm), the
  // quiet user's public fork (Internal label), and pal's PRIVATE fork (the
  // accessible-condition differential). forkParent rides a direct update —
  // RepoService.create has no fork input.
  const pOneId = await mk("p-one");
  const pTwoId = await mk("p-two");
  const pThreeId = await mk("p-three");
  const pFourId = await mk("p-four");
  const quietForkRow = await service.create({
    owner: { id: quiet.id, usernameLower: "fsx-quiet" },
    name: "quiet-fork",
    isPrivate: false,
    status: "ready",
  });
  const quietForkId = quietForkRow.id;
  const palForkRow = await service.create({
    owner: { id: pal.id, usernameLower: "fsx-pal" },
    name: "p-pal",
    isPrivate: true,
    status: "ready",
  });
  const palForkId = palForkRow.id;
  for (const id of [pOneId, pTwoId, pThreeId, pFourId, quietForkId, palForkId]) {
    await db.update(repositories).set({ forkParent: paintId }).where(eq(repositories.id, id));
  }

  // The shape arms: p-one a batched description; p-two archived; p-three the
  // trailing counts (3 stars, 5 pulls of which 2 closed → 3 open);
  // p-four a fixed updatedAt (the Updated line's arm).
  await saveRepoSettings(env.DB, pOneId, { description: "First helper fork." }, T0);
  await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, pTwoId));
  await db
    .update(repositories)
    .set({ numStars: 3, numPulls: 5, numClosedPulls: 2 })
    .where(eq(repositories.id, pThreeId));
  await db.update(repositories).set({ updatedAt: T0 }).where(eq(repositories.id, pFourId));

  // bulk's 41 public forks (the pagination population; ordering is the
  // services' CAST(id)-as-integer tie — the count arms never assert which
  // row lands on which page).
  for (let i = 1; i <= 41; i++) {
    const id = await mk(`bulk-fork-${String(i).padStart(2, "0")}`);
    await db.update(repositories).set({ forkParent: bulkId }).where(eq(repositories.id, id));
  }

  // The social rows: 45 stargazers (the stars pager's population), three
  // watchers (pal first — users.id order puts the card first).
  for (const user of gaz) {
    await starRepo(env.DB, user.id, paintId, T0);
  }
  await watchRepo(env.DB, paintId, pal.id, T0);
  await watchRepo(env.DB, paintId, gazAt(4).id, T0);
  await watchRepo(env.DB, paintId, gazAt(5).id, T0);

  fsxFixture = { paintId, bulkId, blankId, forksRepoId };
  return fsxFixture;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the §2.5 route gates (the private-repo arms wave24's public fixture could not carry) ---

describe("the trio route gates on a private repo (anon/stranger/owner/admin)", () => {
  it("an anonymous viewer 404-shells all three families; the shell carries no repo context", async () => {
    for (const family of ["forks", "stars", "watchers"] as const) {
      const res = await get(`/fsx-owner/vault/${family}`);
      expect(res.status, family).toBe(404);
      const html = await res.text();
      expect(html, family).toContain("status-page-error");
      expect(html, family).not.toContain("repo-header"); // existence hidden
      expect(html, family).not.toContain(`page-content repository ${family === "forks" ? "forks" : "watchers"}`);
    }
  });

  it("a signed-in stranger gets the identical 404 (no grant line admits him)", async () => {
    for (const family of ["forks", "stars", "watchers"] as const) {
      const res = await get(`/fsx-owner/vault/${family}`, "fsx-pal");
      expect(res.status, family).toBe(404);
      const html = await res.text();
      expect(html, family).toContain("status-page-error");
      expect(html, family).not.toContain("fork-list");
      expect(html, family).not.toContain("user-cards");
    }
  });

  it("the owner and the site admin render the private repo's trio (the read grant's arms)", async () => {
    for (const viewer of ["fsx-owner", "fsx-root"]) {
      const forks = await get("/fsx-owner/vault/forks", viewer);
      expect(forks.status, `forks/${viewer}`).toBe(200);
      expect(await forks.text(), `forks/${viewer}`).toContain('class="page-content repository forks"');
      for (const family of ["stars", "watchers"] as const) {
        const res = await get(`/fsx-owner/vault/${family}`, viewer);
        expect(res.status, `${family}/${viewer}`).toBe(200);
        expect(await res.text(), `${family}/${viewer}`).toContain('class="page-content repository watchers"');
      }
    }
  });

  it("an unknown repo 404s the stars and watchers tails too (wave24 pinned the forks one)", async () => {
    expect((await get("/fsx-nobody/nothing/stars")).status).toBe(404);
    expect((await get("/fsx-nobody/nothing/watchers")).status).toBe(404);
  });
});

// --- the fork-row shapes (the arms beyond wave24's link-presence checks) ---------

describe("the forks list shapes on /fsx-owner/paint/forks", () => {
  it("the anonymous count is the public population: five rows (pal's private stays hidden)", async () => {
    const res = await get("/fsx-owner/paint/forks");
    expect(res.status).toBe(200);
    expect(forkRowCount(await res.text())).toBe(5);
  });

  it("a signed-in stranger sees the same five (no own-row and no admin widening)", async () => {
    const res = await get("/fsx-owner/paint/forks", "fsx-g02");
    expect(res.status).toBe(200);
    expect(forkRowCount(await res.text())).toBe(5);
  });

  it("the source owner still does not see another user's private fork", async () => {
    const res = await get("/fsx-owner/paint/forks", "fsx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(forkRowCount(html)).toBe(5);
    expect(html).not.toContain('href="/fsx-pal/p-pal"');
  });

  it("the site admin sees the private fork too (the isAdmin drop) with its Private label", async () => {
    const res = await get("/fsx-owner/paint/forks", "fsx-root");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(forkRowCount(html)).toBe(6);
    const row = forkRow(html, "/fsx-pal/p-pal");
    expect(row).toContain(">Private</span>");
  });

  it("the fork owner sees his own private fork (wave24's arm, re-counted on this fixture)", async () => {
    const res = await get("/fsx-owner/paint/forks", "fsx-pal");
    expect(res.status).toBe(200);
    expect(forkRowCount(await res.text())).toBe(6);
  });

  it("the row carries the batched description, the Updated line, and their absences", async () => {
    const res = await get("/fsx-owner/paint/forks");
    expect(res.status).toBe(200);
    const html = await res.text();
    const described = forkRow(html, "/fsx-owner/p-one");
    expect(described).toContain('<div class="item-body">First helper fork.</div>');
    expect(described).not.toContain("Updated <"); // updatedAt null → no time line
    const updated = forkRow(html, "/fsx-owner/p-four");
    expect(updated).toContain('<div class="item-body">Updated <relative-time'); // T0 stamp
  });

  it("the Archived and Internal (private-visibility owner) labels bind to their rows", async () => {
    const res = await get("/fsx-owner/paint/forks");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(forkRow(html, "/fsx-owner/p-two")).toContain(">Archived</span>");
    expect(forkRow(html, "/fsx-quiet/quiet-fork")).toContain(">Internal</span>");
    // …and the labels do not leak onto the unlabelled rows.
    expect(forkRow(html, "/fsx-owner/p-one")).not.toContain("ui basic label");
  });

  it("the trailing counts read num_stars and the clamped open pulls (5 − 2 = 3)", async () => {
    const res = await get("/fsx-owner/paint/forks");
    expect(res.status).toBe(200);
    const row = forkRow(await res.text(), "/fsx-owner/p-three");
    expect(row).toContain('href="/fsx-owner/p-three/stars"');
    expect(row).toContain('href="/fsx-owner/p-three/pulls"');
    expect(row).toContain('aria-label="Stars"');
    expect(row).toContain('aria-label="Pull Requests"');
    // Both maintained counts render the same value here (3 stars, 3 open).
    expect((row.match(/<span>3<\/span>/g) ?? []).length).toBe(2);
  });
});

// --- the user-card shapes (user_cards.tmpl) ----------------------------------------

describe("the user-card shapes on /fsx-owner/paint/stars", () => {
  it("the card meta falls joined-on → website → location with the javascript: neutralization", async () => {
    const res = await get("/fsx-owner/paint/stars");
    expect(res.status).toBe(200);
    const html = await res.text();
    // g01: no profile → the joined-on fallback.
    expect(cardRow(html, "/fsx-g01")).toContain("Joined on");
    // g02: the display name carries the full name (DisplayNameWithFullName).
    expect(html).toContain('href="/fsx-g02">fsx-g02 (Peak Two)</a>');
    // g03: the http(s) website anchors (target=_blank, text = the URL).
    const website = cardRow(html, "/fsx-g03");
    expect(website).toContain('<a href="https://g03.example.com" target="_blank">https://g03.example.com</a>');
    // g04: a javascript: website never anchors (the ZgotmplZ parity) — the
    // location arm renders instead.
    const neutralized = cardRow(html, "/fsx-g04");
    expect(neutralized).toContain("The Void");
    expect(neutralized).not.toContain("javascript:");
    expect(cardRow(html, "/fsx-g04")).toContain("octicon-location");
  });

  it("the watchers page lists its three watchers", async () => {
    const res = await get("/fsx-owner/paint/watchers");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(cardRowCount(html)).toBe(3);
    expect(html).toContain('href="/fsx-pal"');
    expect(html).toContain('href="/fsx-g05"');
    expect(html).toContain('href="/fsx-g06"');
  });
});

// --- the pagination (the trio never had pager tests) --------------------------------

describe("the trio pagination (?page= over the 40-row ItemsPerPage)", () => {
  it("41 forks page as 40 + Older, then the remainder + a Newer link that drops the param", async () => {
    const first = await get("/fsx-owner/bulk/forks");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(forkRowCount(firstHtml)).toBe(40);
    expect(firstHtml).toContain('<a class="item navigation" href="/fsx-owner/bulk/forks?page=2">');
    expect(firstHtml).toContain("<span class=\"navigation_label\">Older</span>");
    expect(firstHtml).not.toContain(">Newer</span>"); // page 1 offers no Newer

    const second = await get("/fsx-owner/bulk/forks?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(forkRowCount(secondHtml)).toBe(1);
    expect(secondHtml).toContain('<a class="item navigation" href="/fsx-owner/bulk/forks">'); // bare canonical
    expect(secondHtml).toContain("<span class=\"navigation_label\">Newer</span>");
    expect(secondHtml).not.toContain(">Older</span>"); // 41 total → no page 3
  });

  it("the ?page clamps: non-numeric and zero ride page 1; past-the-end renders the empty arm beside the Newer pager", async () => {
    const frog = await get("/fsx-owner/bulk/forks?page=frog");
    expect(frog.status).toBe(200);
    expect(forkRowCount(await frog.text())).toBe(40);

    const zero = await get("/fsx-owner/bulk/forks?page=0");
    expect(zero.status).toBe(200);
    expect(forkRowCount(await zero.text())).toBe(40);

    const far = await get("/fsx-owner/bulk/forks?page=99");
    expect(far.status).toBe(200);
    const farHtml = await far.text();
    expect(forkRowCount(farHtml)).toBe(0);
    expect(farHtml).toContain("No matching results found.");
    expect(farHtml).toContain('<a class="item navigation" href="/fsx-owner/bulk/forks?page=98">');
  });

  it("the stargazers pager keeps the users.id order across pages (40 cards, then 5)", async () => {
    const first = await get("/fsx-owner/paint/stars");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(cardRowCount(firstHtml)).toBe(40);
    expect(firstHtml).toContain('href="/fsx-g01"');
    expect(firstHtml).toContain('href="/fsx-g40"');
    expect(firstHtml).not.toContain('href="/fsx-g41"');
    expect(firstHtml).toContain("/fsx-owner/paint/stars?page=2"); // Older

    const second = await get("/fsx-owner/paint/stars?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(cardRowCount(secondHtml)).toBe(5);
    for (const name of ["fsx-g41", "fsx-g42", "fsx-g43", "fsx-g44", "fsx-g45"]) {
      expect(secondHtml, name).toContain(`href="/${name}"`);
    }
    expect(secondHtml).not.toContain('href="/fsx-g40"');
    expect(secondHtml).toContain('<a class="item navigation" href="/fsx-owner/paint/stars">'); // Newer, bare
  });
});

// --- the empty arms + the no-MustBeNotEmpty differential -----------------------------

describe("the trio's empty arms on a D1-only repo", () => {
  it("all three families render 200 with their empty shapes (no MustBeNotEmpty gate — the tags differential)", async () => {
    const forks = await get("/fsx-owner/blank/forks");
    expect(forks.status).toBe(200);
    const forksHtml = await forks.text();
    expect(forksHtml).toContain('class="page-content repository forks"');
    expect(forksHtml).toContain("No matching results found.");
    expect(forksHtml).not.toContain("<span class=\"navigation_label\">"); // page 1 + !more → no pager

    for (const [family, title] of [
      ["stars", "Stargazers"],
      ["watchers", "Watchers"],
    ] as const) {
      const res = await get(`/fsx-owner/blank/${family}`);
      expect(res.status, family).toBe(200);
      const html = await res.text();
      expect(html, family).toContain('class="page-content repository watchers"');
      expect(html, family).toContain(`<h2 class="ui dividing header">${title}</h2>`);
      expect(cardRowCount(html), family).toBe(0); // the bare empty ul
      expect(html, family).not.toContain("<span class=\"navigation_label\">");
    }
  });
});

// --- the claim pins (parse ↔ registration, beyond wave24's tuples) --------------------

describe("the trio claim pins", () => {
  it("the literals bind case-sensitively (chi pattern parity)", () => {
    expect(parseUiRoute("/fsx-owner/paint/Forks")).toBeNull();
    expect(parseUiRoute("/fsx-owner/paint/STARS")).toBeNull();
    expect(handlesUiRoute("/fsx-owner/paint/Forks")).toBe(false);
  });

  it("/{owner}/forks is the REPO HOME of a repo named forks, and the trio claims its tails over that repo", () => {
    // The two-segment shape is family "home" (the repo page) — the literal is
    // a THIRD segment only.
    expect(parseUiRoute("/fsx-owner/forks")).toEqual({ family: "home", owner: "fsx-owner", repo: "forks", refSuffix: null });
    // The trio families read repo "forks" from the middle segment.
    expect(parseUiRoute("/fsx-owner/forks/forks")).toEqual({ family: "forks", owner: "fsx-owner", repo: "forks" });
    expect(parseUiRoute("/fsx-owner/forks/stars")).toEqual({ family: "stars", owner: "fsx-owner", repo: "forks" });
    // Route-level: the bare URL is the repo home, and the trio's tails serve
    // the repo-named-forks' own (empty) lists.
  });

  it("route-level: a repo named forks renders its home at the bare URL and its stargazers at /forks/stars", async () => {
    const home = await get("/fsx-owner/forks");
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).not.toContain("fork-list"); // the repo home, not a forks list

    const stars = await get("/fsx-owner/forks/stars");
    expect(stars.status).toBe(200);
    const starsHtml = await stars.text();
    expect(starsHtml).toContain('class="page-content repository watchers"');
    expect(starsHtml).toContain("<h2 class=\"ui dividing header\">Stargazers</h2>");
    expect(cardRowCount(starsHtml)).toBe(0);
  });

  it("the owner/repo segments decode per percent-encoding; a malformed encoding stays unclaimed", () => {
    expect(parseUiRoute("/fs%78-owner/paint/forks")).toEqual({ family: "forks", owner: "fsx-owner", repo: "paint" });
    expect(parseUiRoute("/fsx-owner/p%61int/watchers")).toEqual({ family: "watchers", owner: "fsx-owner", repo: "paint" });
    expect(parseUiRoute("/%zz/paint/forks")).toBeNull(); // decodeURIComponent throws → null
    expect(handlesUiRoute("/%zz/paint/forks")).toBe(false);
  });

  it("the watchers deep tail stays unclaimed and 404s at the router (wave24 pinned forks/stars only)", async () => {
    expect(parseUiRoute("/fsx-owner/paint/watchers/x")).toBeNull();
    const res = await get("/fsx-owner/paint/watchers/x");
    // No registration matches the deeper tail, so the sub-app answers its
    // plain 404 (never the shell's status-page renderer — the trio's page
    // classes are absent either way).
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("page-content repository");
  });

  it("the trailing slash 301s onto the canonical literal at the sub-app seam (§4.13)", async () => {
    const res = await get("/fsx-owner/paint/forks/");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/fsx-owner/paint/forks`);
  });
});

// --- the follow/star/watch arms: NOT LANDED (the negative pin) -----------------------

describe("the unlanded follow/star/watch write arms", () => {
  it("POST onto the trio literals answers 404 through the router and mutates nothing", async () => {
    const starsBefore = await countStars(fsxFixture!.paintId);
    const forksBefore = await countForkRows(fsxFixture!.paintId);

    for (const family of ["forks", "stars", "watchers"] as const) {
      const res = await post(`/fsx-owner/paint/${family}`, { uid: "", repo_name: "nope" }, "fsx-owner");
      expect(res.status, family).toBe(404); // GET-only literals: no POST handler exists
    }

    expect(await countStars(fsxFixture!.paintId), "stars unchanged").toBe(starsBefore);
    expect(await countForkRows(fsxFixture!.paintId), "forks unchanged").toBe(forksBefore);
  });

  it("the upstream /action/star literal is unclaimed both ways (no follow/star/watch surface)", async () => {
    expect(parseUiRoute("/fsx-owner/paint/action/star")).toBeNull();
    expect(handlesUiRoute("/fsx-owner/paint/action/star")).toBe(false);
    expect((await get("/fsx-owner/paint/action/star")).status).toBe(404);

    const before = await countStars(fsxFixture!.paintId);
    const res = await post("/fsx-owner/paint/action/star", {}, "fsx-owner");
    expect(res.status).toBe(404);
    expect(await countStars(fsxFixture!.paintId), "no star row written").toBe(before);
  });
});
