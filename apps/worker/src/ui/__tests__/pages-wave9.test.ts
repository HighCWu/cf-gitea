/**
 * Pages wave 9 route tests (SPEC-0008 U3 extension): the signed-in
 * experience — the site root (`/` — the dashboard for a session viewer, the
 * landing page anonymous, upstream Home routers/web/home.go:26-44) and the
 * explore group (`/explore` 303, `/explore/repos`, `/explore/users` —
 * web.go:549-556) over the landed search services through
 * api/services/search.ts.
 *
 * Same harness posture as pages-wave2..8: the router is driven directly with
 * the synthetic ASSETS manifest, engine content seeds through the REAL
 * receive flow (testing/seed-repo.ts), and the session wave's conventions
 * provide the identities (mintSession cookies — the wave-4 pattern).
 *
 * Visibility under test: the dashboard's own-repo list (isOwner grants the
 * private rows), its watched list filtered through the SHARED readGrant
 * predicate (a watched private repo of another owner never surfaces), and
 * the explore scopes (anonymous sees public repos / active individual users;
 * a signed-in viewer gains their own private repos; org rows and prohibited
 * accounts never surface on the users page).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { issues, repositories, users } from "../../db/schema";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { isWatchingRepo, watchRepo } from "../../api/services/repo-watchers";
import { IssuesService } from "../../issues/service";
import { OrgService } from "../../services/orgs/orgs";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie =
  (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

// --- fixtures -----------------------------------------------------------------

const WAVE9_COMMITS: SeedCommit[] = [
  {
    message: "seed: wave9 readme",
    time: T0,
    files: [{ path: "README.md", content: "# wave9 seed\n" }],
  },
];

interface Wave9Fixture {
  aliceCookie: string;
  bobCookie: string;
  carolCookie: string;
}

let wave9Fixture: Wave9Fixture | null = null;

/** A public/private repository row without engine content (the wave-8
 *  row-only sibling pattern) — the explore/dashboard lists read D1 only. */
async function ensureRowRepo(owner: { id: number; usernameLower: string }, slug: string, visibility: "public" | "private"): Promise<string> {
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.slug, slug))
    .get();
  if (existing !== undefined) return existing.id;
  const id = `r_wave9-${slug}`;
  await db.insert(repositories).values({
    id,
    storageKey: id,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug,
    visibility,
  });
  return id;
}

async function ensureWave9Fixtures(): Promise<Wave9Fixture> {
  if (wave9Fixture !== null) return wave9Fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wave9", commits: WAVE9_COMMITS });

  for (const extra of [
    { username: "wave9bob", isAdmin: false, status: "active" as const },
    { username: "wave9carol", isAdmin: false, status: "active" as const },
    { username: "wave9ghost", isAdmin: false, status: "prohibited" as const },
  ]) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: extra.username,
        usernameLower: extra.username,
        isAdmin: extra.isAdmin,
        status: extra.status,
        visibility: "public",
        location: extra.username === "wave9carol" ? "Carol's Harbor" : null,
        createdAt: new Date(),
      });
    }
  }
  const alice = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, "wave9bob")).get();
  const carol = await db.select().from(users).where(eq(users.usernameLower, "wave9carol")).get();
  if (alice === undefined || bob === undefined || carol === undefined) throw new Error("wave9 identity rows missing");

  // The org row sharing the users table — explore/users must never list it.
  const orgs = new OrgService(env.DB);
  if ((await orgs.getOrgByUsername("wave9org")) === null) {
    await orgs.createOrg({ name: "wave9org", ownerId: carol.id, visibility: "public", now: new Date(T0 * 1000) });
  }

  // The repo rows: alice's engine-seeded public repo + her private row-only
  // sibling; bob's public and private row-only repos (the watched pair).
  await ensureRowRepo({ id: alice.id, usernameLower: "alice" }, "wave9-secret", "private");
  await ensureRowRepo({ id: bob.id, usernameLower: "wave9bob" }, "bobpublic", "public");
  await ensureRowRepo({ id: bob.id, usernameLower: "wave9bob" }, "bobsecret", "private");

  // The dashboard's watched pair: bobpublic (grants — visible) and
  // bobsecret (private, not alice's — readGrant filters it).
  const bobPublicId = await ensureRowRepo({ id: bob.id, usernameLower: "wave9bob" }, "bobpublic", "public");
  const bobSecretId = await ensureRowRepo({ id: bob.id, usernameLower: "wave9bob" }, "bobsecret", "private");
  if (!(await isWatchingRepo(env.DB, bobPublicId, alice.id))) {
    await watchRepo(env.DB, bobPublicId, alice.id, new Date(T0 * 1000));
  }
  if (!(await isWatchingRepo(env.DB, bobSecretId, alice.id))) {
    await watchRepo(env.DB, bobSecretId, alice.id, new Date(T0 * 1000));
  }

  // The activity thread: alice's issue on her repo, commented by bob — the
  // foreign-activity arm of the derived-thread read. Idempotent: any issue
  // row on the repo skips the block (the wave-2 fixture posture).
  const wave9 = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.slug, "wave9"))
    .get();
  if (wave9 === undefined) throw new Error("wave9 repo row missing");
  const existingIssue = await drizzle(env.DB)
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.repoId, wave9.id))
    .limit(1)
    .all();
  if (existingIssue.length === 0) {
    const svc = new IssuesService(env.DB);
    const issue = await svc.createIssue({
      repoId: wave9.id,
      title: "wave9: the dashboard activity thread",
      content: "Opened by alice; commented by bob.",
      posterId: alice.id,
      now: new Date((T0 + 10) * 1000),
    });
    await svc.addComment({
      issueId: issue.id,
      posterId: bob.id,
      content: "Foreign activity for the dashboard line.",
      now: new Date((T0 + 20) * 1000),
    });
  }

  // The explore pagination block: 21 row-only PUBLIC repos owned by BOB,
  // named wave9-p01..p21 (slug-ordered) — alice's own list stays two rows
  // (the dashboard cap and the explore page-1 own-private assertions stay
  // exact). Anonymous q=wave9 matches 22 public rows: page 1 carries 20 +
  // the Older link, page 2 the last two. Idempotent by slug lookup.
  for (let i = 1; i <= 21; i++) {
    await ensureRowRepo({ id: bob.id, usernameLower: "wave9bob" }, `wave9-p${String(i).padStart(2, "0")}`, "public");
  }

  // Deterministic sort fixtures: p01/p02/p03 carry pinned createdAt values
  // (the row-only inserts otherwise stamp wall-clock unixepoch()), so the
  // newest/oldest orders assert deterministically.
  for (const [slug, created] of [
    ["wave9-p01", T0 + 1000],
    ["wave9-p02", T0],
    ["wave9-p03", T0 + 5],
  ] as Array<[string, number]>) {
    await db
      .update(repositories)
      .set({ createdAt: new Date(created * 1000) })
      .where(eq(repositories.slug, slug));
  }

  wave9Fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    bobCookie: await mintSession(env.DB, bob.id),
    carolCookie: await mintSession(env.DB, carol.id),
  };
  return wave9Fixture;
}

beforeAll(async () => {
  await ensureWave9Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-9 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the site root and the explore literals", () => {
    expect(parseUiRoute("/")).toEqual({ family: "site-home" });
    expect(parseUiRoute("/explore")).toEqual({ family: "explore-root" });
    expect(parseUiRoute("/explore/repos")).toEqual({ family: "explore-repos" });
    expect(parseUiRoute("/explore/users")).toEqual({ family: "explore-users" });
    expect(handlesUiRoute("/explore/users")).toBe(true);
  });

  it("leaves every other /explore tail and the same-named namespaces alone", () => {
    // The orgs page (the raw/media wave's R01) claimed the literal — the
    // stale toBeNull pin updated to the claimed shape (the explore matrix's
    // disclosure).
    expect(parseUiRoute("/explore/organizations")).toEqual({ family: "explore-organizations" });
    // Window-2e-A (84996c6) mounted the sitemap literals — the stale
    // toBeNull pin updated to the claimed shape (the explore matrix's
    // disclosure).
    expect(parseUiRoute("/explore/repos/sitemap-1.xml")).toEqual({ family: "explore-repos-sitemap", idx: 1 });
    expect(parseUiRoute("/EXPLORE")).toEqual({ family: "owner-home", owner: "EXPLORE" });
  });
});

// --- the site root -------------------------------------------------------------

describe("site root (/)", () => {
  it("renders the landing page anonymous (upstream home.tmpl reduced)", async () => {
    const res = await fetchUi("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Home" class="page-content home">');
    expect(html).toContain("<h1 class=\"ui icon header title\">cf-gitea</h1>");
    expect(html).toContain("A painless, self-hosted Git service");
    // No dashboard sections leak onto the landing.
    expect(html).not.toContain("Watched Repositories");
    expect(html).not.toContain("Recent activity");
  });

  it("renders the dashboard signed in: own repos (private included), watched repos, activity", async () => {
    const fixture = await ensureWave9Fixtures();
    const res = await fetchUi("/", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Dashboard" class="page-content dashboard feeds">');
    // The logo's aria-label switches with the session (head_navbar.tmpl:2).
    expect(html).toContain('id="navbar-logo" href="/" aria-label="Dashboard"');
    expect(html).toContain('id="dashboard-repo-list" class="flex-container-sidebar"');
    // Own repos: the engine-seeded public repo AND the private sibling.
    expect(html).toContain('href="/alice/wave9"');
    expect(html).toContain('href="/alice/wave9-secret"');
    expect(html).toContain("Private</span>"); // the private badge on the sibling
    // Watched: the granted public repo renders; the private foreign one
    // never does (the shared readGrant filter).
    expect(html).toContain('href="/wave9bob/bobpublic"');
    expect(html).not.toContain("/wave9bob/bobsecret");
    // The activity line: bob's comment made alice a recipient with foreign
    // activity; the line anchors the issue detail page.
    expect(html).toContain("wave9: the dashboard activity thread #1");
    expect(html).toContain('href="/alice/wave9/issues/1"');
  });

  it("is a per-user mailbox: the commenter sees the thread, an unrelated viewer does not", async () => {
    const fixture = await ensureWave9Fixtures();
    // Bob commented on alice's issue — the recipient disjunction's commenter
    // arm makes it HIS thread too (foreign activity: alice authored).
    const bob = await fetchUi("/", withCookie(fixture.bobCookie));
    expect(bob.status).toBe(200);
    expect(await bob.text()).toContain("wave9: the dashboard activity thread #1");

    // Carol has no relationship to the issue — her mailbox is empty.
    const carol = await fetchUi("/", withCookie(fixture.carolCookie));
    expect(carol.status).toBe(200);
    expect(await carol.text()).toContain("No recent activity.");
  });
});

// --- the explore root redirect ---------------------------------------------------

describe("explore root (/explore)", () => {
  it("303s onto the repos page (upstream web.go:550-552)", async () => {
    const res = await fetchUi("/explore");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/explore/repos");
  });
});

// --- the explore repos page ------------------------------------------------------

describe("explore repos (/explore/repos)", () => {
  it("lists public repos anonymous, private hidden; the navbar item is active", async () => {
    const res = await fetchUi("/explore/repos");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Explore" class="page-content explore repositories">');
    expect(html).toContain('<a class="active item" href="/explore/repos">');
    expect(html).toContain('<a class="item" href="/explore/users">');
    expect(html).toContain('<a class="active item" href="/explore/repos">Explore</a>'); // the navbar track
    // The engine-seeded public repo and bob's public row render; private
    // rows never surface for anonymous.
    expect(html).toContain('href="/alice/wave9"');
    expect(html).toContain('href="/wave9bob/bobpublic"');
    expect(html).not.toContain("/alice/wave9-secret");
    expect(html).not.toContain("/wave9bob/bobsecret");
    // The search box keeps the upstream combo shape and re-submits ?q=.
    expect(html).toContain('<form class="ui form ignore-dirty tw-flex-1" method="get" action="/explore/repos">');
    expect(html).toContain('<input type="search" name="q" value="" maxlength="255"');
  });

  it("narrows by ?q= and renders the upstream no-results line on a miss", async () => {
    const hit = await fetchUi("/explore/repos?q=bobpublic");
    expect(hit.status).toBe(200);
    const hitHtml = await hit.text();
    expect(hitHtml).toContain('href="/wave9bob/bobpublic"');
    expect(hitHtml).not.toContain('href="/alice/wave9"');
    expect(hitHtml).toContain('value="bobpublic"'); // the keyword round-trips

    const miss = await fetchUi("/explore/repos?q=never-matches-anything");
    expect(miss.status).toBe(200);
    expect(await miss.text()).toContain("No matching results found.");
  });

  it("gains the viewer's own private repos signed in, never a foreign private row", async () => {
    const fixture = await ensureWave9Fixtures();
    // The keyword isolates the private sibling (page 1's 20 slots are
    // alphabetically earlier rows — the scope change is what's under test).
    const mine = await fetchUi("/explore/repos?q=wave9-secret", withCookie(fixture.aliceCookie));
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain('href="/alice/wave9-secret"');

    // Anonymous never sees it, and bob's private row stays hidden from
    // alice too (the Private: ctx.Doer scope covers OWN rows only).
    const anon = await fetchUi("/explore/repos?q=wave9-secret");
    expect(await anon.text()).toContain("No matching results found.");
    const foreign = await fetchUi("/explore/repos?q=bobsecret", withCookie(fixture.aliceCookie));
    expect(await foreign.text()).toContain("No matching results found.");
  });

  it("honors ?sort= through the mapped modes and degrades unknown values", async () => {
    // The keyword set is wave9-p01..p09 (the LIKE substring wave9-p0) with
    // pinned createdAt values: newest (created desc) puts p01 first, oldest
    // (created asc) p02 — the mapped web sorts through the landed service.
    const newest = await fetchUi("/explore/repos?q=wave9-p0&sort=newest");
    expect(newest.status).toBe(200);
    const newestHtml = await newest.text();
    expect(newestHtml.indexOf("/wave9bob/wave9-p01")).toBeLessThan(newestHtml.indexOf("/wave9bob/wave9-p02"));

    const oldest = await fetchUi("/explore/repos?q=wave9-p0&sort=oldest");
    const oldestHtml = await oldest.text();
    expect(oldestHtml.indexOf("/wave9bob/wave9-p02")).toBeLessThan(oldestHtml.indexOf("/wave9bob/wave9-p01"));

    // Unknown values degrade to the landed default (slug order — never a
    // 422; upstream falls back to recentupdate).
    const banana = await fetchUi("/explore/repos?sort=banana");
    expect(banana.status).toBe(200);
  });

  it("paginates 20-per-page with the keyword preserved (ExplorePagingNum)", async () => {
    const page1 = await fetchUi("/explore/repos?q=wave9");
    expect(page1.status).toBe(200);
    const page1Html = await page1.text();
    expect(page1Html).toContain("?q=wave9&amp;page=2"); // the Older link keeps ?q=
    // Page 2 exists and carries the 21st row (wave9-r21 sorts last).
    const page2 = await fetchUi("/explore/repos?q=wave9&page=2");
    expect(page2.status).toBe(200);
    const page2Html = await page2.text();
    expect(page2Html).toContain('href="/wave9bob/wave9-p21"');
    expect(page2Html).not.toContain('href="/wave9bob/wave9-p01"');
    expect(page2Html).toContain("<span class=\"navigation_label\">Newer</span>");
  });
});

// --- the explore users page ------------------------------------------------------

describe("explore users (/explore/users)", () => {
  it("lists active individual users only — no org rows, no prohibited accounts", async () => {
    const res = await fetchUi("/explore/users");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Explore" class="page-content explore users">');
    expect(html).toContain('<a class="item" href="/explore/repos">');
    // The active individual users render with their profile links.
    expect(html).toContain('href="/wave9bob">wave9bob</a>');
    expect(html).toContain('href="/wave9carol">wave9carol</a>');
    expect(html).toContain("Carol&#39;s Harbor"); // the location row
    expect(html).toContain("Joined on"); // the upstream user_list row body
    // The org sharing the users table and the prohibited account never do.
    expect(html).not.toContain("/wave9org");
    expect(html).not.toContain("/wave9ghost");
    expect(html).toContain('<form class="ui form ignore-dirty tw-flex-1" method="get" action="/explore/users">');
    expect(html).toContain('placeholder="Search users');
  });

  it("narrows by ?q= and orders by the upstream sorts (newest default)", async () => {
    const hit = await fetchUi("/explore/users?q=carol");
    expect(hit.status).toBe(200);
    const hitHtml = await hit.text();
    expect(hitHtml).toContain('href="/wave9carol">wave9carol</a>');
    expect(hitHtml).not.toContain('href="/wave9bob">');

    // Default sort = newest (id DESC): carol was inserted after bob.
    const newest = await fetchUi("/explore/users");
    const newestHtml = await newest.text();
    expect(newestHtml.indexOf("/wave9carol")).toBeLessThan(newestHtml.indexOf("/wave9bob"));

    // alphabetically flips the pair (bob < carol).
    const alpha = await fetchUi("/explore/users?sort=alphabetically");
    const alphaHtml = await alpha.text();
    expect(alphaHtml.indexOf("/wave9bob")).toBeLessThan(alphaHtml.indexOf("/wave9carol"));

    // Unknown values degrade to the default (upstream would 404 — the
    // documented divergence).
    const banana = await fetchUi("/explore/users?sort=banana");
    expect(banana.status).toBe(200);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-9 a11y smoke", () => {
  it("the new pages pass the structural rules", async () => {
    const fixture = await ensureWave9Fixtures();
    for (const [path, init] of [
      ["/", undefined],
      ["/", withCookie(fixture.aliceCookie)],
      ["/explore/repos", undefined],
      ["/explore/users", undefined],
      ["/explore/repos?q=never-matches-anything", undefined], // the empty render
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
