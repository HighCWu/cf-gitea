/**
 * Pages wave 7 route tests (SPEC-0008 U3 extension): the user profile page
 * (`/{username}` — pages/user-profile.tsx, the USER half of the wave-6
 * single-segment owner-home family) and the dead-link unlock it enables
 * (every landed poster/owner name anchors the profile through `userLink` —
 * pinned here where the goldens don't carry a session: the navbar link).
 *
 * Same harness posture as waves 4-6: the router is driven directly with the
 * synthetic ASSETS manifest, fixtures seed through the landed services with
 * fixed values, and identities ride minted session cookies. The alice
 * fixture comes from the shared golden harness (setupGoldenFixtures); this
 * file adds its own users (public with profile metadata / limited /
 * private + follower + co-member / rename pairs / prohibited / paging) and
 * repos, so the committed goldens' fixture repos stay read-only here.
 *
 * Visibility posture under test (the §2.5 anti-enumeration rule): the user
 * resolves through upstream userAssignment's shape — a renamed user 307s
 * behind the coarse RedirectToUser gate, an org name or an unknown name
 * never reaches this half, and IsUserVisibleToViewer gates the page:
 * limited needs any signed-in viewer, private needs follower/co-member/
 * self/admin, prohibited is invisible to everyone (§4.8). Anything not
 * visible 404-shells, indistinguishable from missing.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { userRedirects, users } from "../../db/schema";import { uiRouter } from "../index";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { followUser } from "../../api/services/follows";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { renderRoute, setupGoldenFixtures, T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

// --- fixtures -----------------------------------------------------------------

interface Wave7Fixture {
  galCookie: string; // wave7gal — the public profile owner
  ghostCookie: string; // wave7ghost — the private profile owner
  palCookie: string; // wave7pal — ghost's follower (ghost follows pal)
  mateCookie: string; // wave7mate — ghost's co-member
  adminCookie: string; // wave7boss — site admin
}

let wave7Fixture: Wave7Fixture | null = null;

/**
 * Seed the wave-7 block on top of the shared golden fixtures. Idempotent at
 * every step (user/org lookups gate creations, the repo blocks guard on
 * their rows). The `wave7gal` profile columns and `createdAt` are pinned to
 * T0-derived values so every assertion is byte-stable (§5.2).
 */
async function ensureWave7Fixtures(): Promise<Wave7Fixture> {
  if (wave7Fixture !== null) return wave7Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);
  const service = new RepoService(env.DB);

  // The public profile owner: display name, bio, location, website, and two
  // repos (one public with a description, one private — hidden from anyone
  // but herself/admins).
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave7gal")).get()) === undefined) {
    await db.insert(users).values({
      username: "wave7gal",
      usernameLower: "wave7gal",
      status: "active",
      visibility: "public",
      fullName: "Wave Seven Gal",
      description: "Building the seventh wave.",
      location: "Test Harbor",
      website: "https://wave7.example",
      createdAt: t(0),
    });
    const gal = (await db.select().from(users).where(eq(users.usernameLower, "wave7gal")).get())!;
    const pub = await service.create({
      owner: { id: gal.id, usernameLower: "wave7gal" },
      name: "public-work",
      isPrivate: false,
      status: "ready",
    });
    await saveRepoSettings(env.DB, pub.id, { description: "Open tools for the wave." }, t(1));
    await service.create({
      owner: { id: gal.id, usernameLower: "wave7gal" },
      name: "secret-work",
      isPrivate: true,
      status: "ready",
    });
  }

  // The private profile owner + her viewer relations: a follower (upstream's
  // verbatim IsFollowing(u.ID, viewer.ID) — ghost FOLLOWS pal) and a
  // co-member of a shared org.
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave7ghost")).get()) === undefined) {
    await db.insert(users).values({
      username: "wave7ghost",
      usernameLower: "wave7ghost",
      status: "active",
      visibility: "private",
      createdAt: t(0),
    });
  }
  for (const name of ["wave7pal", "wave7mate", "wave7boss"]) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, name)).get()) === undefined) {
      await db.insert(users).values({
        username: name,
        usernameLower: name,
        isAdmin: name === "wave7boss",
        status: "active",
        visibility: "public",
        createdAt: t(0),
      });
    }
  }
  const ghost = (await db.select().from(users).where(eq(users.usernameLower, "wave7ghost")).get())!;
  const pal = (await db.select().from(users).where(eq(users.usernameLower, "wave7pal")).get())!;
  const mate = (await db.select().from(users).where(eq(users.usernameLower, "wave7mate")).get())!;
  await followUser(env.DB, ghost.id, pal.id);
  if ((await orgs.getOrgByUsername("wave7club")) === null) {
    const club = await orgs.createOrg({ name: "wave7club", ownerId: pal.id, visibility: "public", now: t(0) });
    await orgs.addMember(club.id, ghost.id, { now: t(0) });
    await orgs.addMember(club.id, mate.id, { now: t(0) });
  }

  // The limited profile (any signed-in viewer may read).
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave7shy")).get()) === undefined) {
    await db.insert(users).values({
      username: "wave7shy",
      usernameLower: "wave7shy",
      status: "active",
      visibility: "limited",
      createdAt: t(0),
    });
  }

  // The prohibited profile (invisible to EVERY viewer — §4.8).
  await seedVerifiedUser({ status: "prohibited", username: "wave7gone" });

  // The rename pair: /w7old 307s onto /w7new (public target). The private
  // rename pair answers the coarse RedirectToUser gate: 404 for anonymous.
  const renamed = await db.select().from(users).where(eq(users.usernameLower, "w7new")).get();
  if (renamed === undefined) {
    await db.insert(users).values({
      username: "w7new",
      usernameLower: "w7new",
      status: "active",
      visibility: "public",
      createdAt: t(0),
    });
    const w7new = (await db.select().from(users).where(eq(users.usernameLower, "w7new")).get())!;
    await db.insert(userRedirects).values({ lowerName: "w7old", redirectUserId: w7new.id });
  }
  const renamedPriv = await db.select().from(users).where(eq(users.usernameLower, "w7newpriv")).get();
  if (renamedPriv === undefined) {
    await db.insert(users).values({
      username: "w7newpriv",
      usernameLower: "w7newpriv",
      status: "active",
      visibility: "private",
      createdAt: t(0),
    });
    const target = (await db.select().from(users).where(eq(users.usernameLower, "w7newpriv")).get())!;
    await db.insert(userRedirects).values({ lowerName: "w7oldpriv", redirectUserId: target.id });
  }

  // The paging profile: 16 public repos — one page of 15 + a one-row second
  // page (upstream RepoPagingNum = 15).
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave7bulk")).get()) === undefined) {
    await db.insert(users).values({
      username: "wave7bulk",
      usernameLower: "wave7bulk",
      status: "active",
      visibility: "public",
      createdAt: t(0),
    });
    const bulk = (await db.select().from(users).where(eq(users.usernameLower, "wave7bulk")).get())!;
    for (let i = 0; i < 16; i++) {
      await service.create({
        owner: { id: bulk.id, usernameLower: "wave7bulk" },
        name: `bulk-${String(i).padStart(2, "0")}`,
        isPrivate: false,
        status: "ready",
      });
    }
  }

  wave7Fixture = {
    galCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave7gal")).get())!.id),
    ghostCookie: await mintSession(env.DB, ghost.id),
    palCookie: await mintSession(env.DB, pal.id),
    mateCookie: await mintSession(env.DB, mate.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave7boss")).get())!.id),
  };
  return wave7Fixture;
}

// The shared golden fixtures register their own beforeAll (module scope —
// hook registration must happen before the run phase), and run FIRST: the
// alice fixture is this file's golden-profile base.
setupGoldenFixtures();

beforeAll(async () => {
  await ensureWave7Fixtures();
});

// --- the user profile page ------------------------------------------------------

describe("user profile (/{username})", () => {
  it("renders the public profile for anonymous: avatar card, badge-less username, display name, bio, joined date", async () => {
    const { status, html } = await renderRoute("/wave7gal");
    expect(status).toBe(200);
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain("<title>Wave Seven Gal - cf-gitea</title>");
    // The avatar placeholder circle (no avatar pipeline — the avatar-slot
    // rule), the username WITHOUT a visibility badge (public), the display
    // name, the plain-text follower/following counts (the tab pages do not
    // exist — no dead links).
    expect(html).toContain('id="profile-avatar-card"');
    expect(html).toContain('class="svg octicon-person"');
    expect(html).toContain(">wave7gal</span>");
    expect(html).not.toContain(">Limited</span>");
    expect(html).not.toContain(">Private</span>");
    expect(html).toContain('<span class="tw-text-center">Wave Seven Gal</span>');
    expect(html).toContain("0 followers");
    expect(html).toContain("0 following");
    expect(html).toContain("Test Harbor");
    expect(html).toContain('rel="me" href="https://wave7.example"');
    expect(html).toContain("Building the seventh wave.");
    expect(html).toContain(`Joined on Nov 14, 2023`); // T0 — the pinned fixture epoch
  });

  it("lists the user's PUBLIC repos only, reusing the shared/repo/list row DOM", async () => {
    const { html } = await renderRoute("/wave7gal");
    expect(html).toContain('href="/wave7gal/public-work"');
    expect(html).toContain("Open tools for the wave.");
    expect(html).toContain('href="/wave7gal/public-work/pulls"'); // the row's live counter link
    expect(html).not.toContain("/wave7gal/secret-work"); // the private row never leaks
    expect(html).toContain("Repositories"); // the single live tab
    expect(html).toContain('<div class="ui small label">1</div>'); // the visible count
  });

  it("shows the private rows to the owner and a site admin, with the Private badge", async () => {
    const fixture = await ensureWave7Fixtures();
    for (const cookie of [fixture.galCookie, fixture.adminCookie]) {
      const res = await fetchUi("/wave7gal", { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/wave7gal/secret-work"');
      expect(html).toContain(">Private</span>"); // the row badge (a public owner → no Internal badge)
      expect(html).toContain('<div class="ui small label">2</div>');
    }
  });

  it("renders the empty list wrapper for a repo-less user (shared/repo/list.tmpl:1, no placeholder)", async () => {
    const fixture = await ensureWave7Fixtures();
    const res = await fetchUi("/wave7shy", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.palCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="flex-divided-list items-with-main"');
    // The live tab (b1bf73a's ProfileTabs re-shape: header.tmpl:12's exact
    // `?tab=repositories` href, ACTIVE — no longer OrgMenu's canonical link)
    expect(html).toContain('class="active item" href="/wave7shy?tab=repositories"');
    expect(html).toContain('href="/wave7shy?tab=activity"'); // the strip's other live anchor
    expect(html).not.toContain("No repositories yet."); // that placeholder is the ORG page's
  });

  it("gates a LIMITED user: 404 for anonymous, 200 + badge for any signed-in viewer", async () => {
    const fixture = await ensureWave7Fixtures();
    const anon = await fetchUi("/wave7shy");
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("Page Not Found"); // existence hidden

    const authed = await fetchUi("/wave7shy", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.palCookie}` },
    });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toContain(">Limited</span>");
  });

  it("gates a PRIVATE user: anonymous and unrelated viewers 404; follower, co-member, self and admin see it", async () => {
    const fixture = await ensureWave7Fixtures();
    expect((await fetchUi("/wave7ghost")).status).toBe(404);
    const unrelated = await fetchUi("/wave7ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.galCookie}` },
    });
    expect(unrelated.status).toBe(404); // signed-in but no relation — still hidden

    // The follower (upstream IsFollowing(u.ID, viewer.ID) — ghost follows pal).
    const follower = await fetchUi("/wave7ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.palCookie}` },
    });
    expect(follower.status).toBe(200);

    // The co-member (a shared org row pair).
    const comember = await fetchUi("/wave7ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.mateCookie}` },
    });
    expect(comember.status).toBe(200);

    // Self and site admin short-circuit the ladder.
    const self = await fetchUi("/wave7ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ghostCookie}` },
    });
    expect(self.status).toBe(200);
    expect(await self.text()).toContain(">Private</span>");
    const admin = await fetchUi("/wave7ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(admin.status).toBe(200);
  });

  it("404-shells a PROHIBITED user for every viewer (§4.8 — invisible, never a login error)", async () => {
    const fixture = await ensureWave7Fixtures();
    for (const init of [undefined, { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` } }]) {
      const res = await fetchUi("/wave7gone", init);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Page Not Found");
    }
  });

  it("307s a renamed user onto the new name behind the coarse RedirectToUser gate", async () => {
    // Public target: the redirect answers everyone.
    const redirect = await fetchUi("/w7old?x=1");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/w7new?x=1");
    expect((await fetchUi("/w7new")).status).toBe(200);

    // Private target + anonymous: the gate folds it into a miss (no leak).
    const gated = await fetchUi("/w7oldpriv");
    expect(gated.status).toBe(404);
  });

  it("never serves the user page for an org name (the org half answers first)", async () => {
    const res = await fetchUi("/acme");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="page-content organization profile"');
  });

  it("paginates at the upstream RepoPagingNum (15): page 1 Older, page 2 the remainder + Newer", async () => {
    const first = await fetchUi("/wave7bulk");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("bulk-00");
    expect(firstHtml).not.toContain("bulk-15");
    expect(firstHtml).toContain("Older");

    const second = await fetchUi("/wave7bulk?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).not.toContain("bulk-00");
    expect(secondHtml).toContain("bulk-15");
    expect(secondHtml).toContain("Newer");
    expect(secondHtml).not.toContain("Older");
  });

  it("renders identical bytes twice (no request-state bleed across profile pages)", async () => {
    const first = await renderRoute("/wave7gal");
    const second = await renderRoute("/wave7gal");
    expect(second.html).toBe(first.html);
  });
});

// --- the dead-link unlock -------------------------------------------------------

describe("wave-7 dead-link unlock (poster/owner names link profiles)", () => {
  it("anchors the signed-in navbar username to the profile (userLink shape)", async () => {
    const fixture = await ensureWave7Fixtures();
    const res = await fetchUi("/wave7gal", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.galCookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<a class="item" id="navbar-username" href="/wave7gal">wave7gal</a>');
  });

  it("anchors issue-list event-line posters (the golden bytes carry the same shape)", async () => {
    const { html } = await renderRoute("/alice/golden/issues");
    expect(html).toContain('by <a href="/alice">alice</a>');
  });

  it("keeps the golden org-home rows link-shaped and the profile page a11y-clean (anonymous + private signed-in)", async () => {
    const fixture = await ensureWave7Fixtures();
    for (const path of ["/wave7gal", "/alice"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
    const privateView = await fetchUi("/wave7ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.palCookie}` },
    });
    expect(privateView.status).toBe(200);
    expect(runA11y(await privateView.text())).toEqual([]);
  });
});
