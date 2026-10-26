/**
 * The user profile page's deferred matrix (the module MOUNTED since the
 * early waves — GET /{username} at ui/index.ts, pages/user-profile.tsx, the
 * USER half of the single-segment owner-home family): the route-level arms
 * the wave-7 block (ui/__tests__/pages-wave7.test.ts) left open, driven
 * through the REAL routes on the tags 01fae9e matrix's minted-session
 * pattern —
 *
 *   - the private/limited visibility CONTINUATION: wave 7 pins the ladder's
 *     status codes only; here the followed viewer's PAGE CONTENT is pinned
 *     (the public-only repo WHERE for a non-admin non-self doer, the
 *     `Internal` badge a private owner's public row wears, the LIMITED
 *     owner's private repo staying hidden from a signed-in stranger),
 *   - the org-home vs user-home discrimination (mixed-case resolve, an org
 *     name ignoring ?tab=activity exactly like upstream's org.Home),
 *   - the ?tab=activity arm's rendering: the activity page module
 *     (pages/activity-feeds.tsx) is UNMOUNTED at this pin — its header's
 *     HANDOFF NOTE leaves the route arm to a later window — so the query
 *     param is INERT: the repositories view renders, no activity DOM, the
 *     overview anchors stay canonical (no `?tab=` anywhere). These arms pin
 *     the documented intermediate posture; they must be re-armed when the
 *     dispatch wave mounts the page,
 *   - the renamed-user redirect arms wave 7 lacks: the PRIVATE and LIMITED
 *     targets answering a signed-in doer with the 307 (the coarse
 *     RedirectToUser gate passes any authenticated principal — only the
 *     anonymous viewer folds into the miss), the display-cased location
 *     rewrite, and the multi-param query preservation,
 *   - the plain unknown-name 404 shells (existence never leaks, not even to
 *     a site admin),
 *   - and the owner-home family's claim pin (parse ↔ registration: the
 *     reserved/excluded/suffix refusals, the feed-suffix claims, the
 *     two-segment never-profile shape).
 *
 * Fixture posture: wave 7's idempotent ensure-once seeding (its block owns
 * its own users; this file adds a disjoint `up*` family) with sessions
 * minted PER REQUEST (the tags-wave pattern — the value is never asserted).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { followUser } from "../../api/services/follows";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { userRedirects, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const FIXED_DATE = new Date("2026-01-15T00:00:00Z");

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

/** The real production path: parse → resolveUiSession → the owner-home
 *  handler (org half, then user half) → load → render/redirect, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  if (as === undefined) return fetchUi(path);
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, as)).get();
  if (user === undefined) throw new Error(`fixture user missing: ${as}`);
  return fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}` } });
}

let seeded = false;

/**
 * Seed the disjoint `up*` fixture family (idempotent on the `upgal`
 * sentinel — the wave-7 ensure-once posture). Relations: uppriv FOLLOWS
 * uppal (upstream's verbatim IsFollowing(u.ID, viewer.ID) — the target
 * follows the viewer), uporg is uppal's org, and the three rename pairs
 * point at public/private/limited targets.
 */
async function ensureFixtures(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);
  const service = new RepoService(env.DB);

  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "upgal")).get()) !== undefined) return;

  // The public profile owner with one public + one private repo.
  await db.insert(users).values({
    username: "upgal",
    usernameLower: "upgal",
    status: "active",
    visibility: "public",
    fullName: "Up Gal",
    createdAt: FIXED_DATE,
  });
  const gal = (await db.select().from(users).where(eq(users.usernameLower, "upgal")).get())!;
  const open = await service.create({ owner: { id: gal.id, usernameLower: "upgal" }, name: "upopen", isPrivate: false, status: "ready" });
  await saveRepoSettings(env.DB, open.id, { description: "The open one." }, FIXED_DATE);
  await service.create({ owner: { id: gal.id, usernameLower: "upgal" }, name: "uphidden", isPrivate: true, status: "ready" });

  // The plain viewers: uppal (followed by the private owner) and upadmin.
  for (const name of ["uppal", "upadmin"]) {
    await db.insert(users).values({
      username: name,
      usernameLower: name,
      status: "active",
      visibility: "public",
      isAdmin: name === "upadmin",
      createdAt: FIXED_DATE,
    });
  }

  // The private profile owner + her follower relation + repos.
  await db.insert(users).values({
    username: "uppriv",
    usernameLower: "uppriv",
    status: "active",
    visibility: "private",
    createdAt: FIXED_DATE,
  });
  const priv = (await db.select().from(users).where(eq(users.usernameLower, "uppriv")).get())!;
  const pal = (await db.select().from(users).where(eq(users.usernameLower, "uppal")).get())!;
  await followUser(env.DB, priv.id, pal.id); // uppriv follows uppal
  await service.create({ owner: { id: priv.id, usernameLower: "uppriv" }, name: "upexposed", isPrivate: false, status: "ready" });
  await service.create({ owner: { id: priv.id, usernameLower: "uppriv" }, name: "upstash", isPrivate: true, status: "ready" });

  // The limited profile owner with one private repo.
  await db.insert(users).values({
    username: "upshy",
    usernameLower: "upshy",
    status: "active",
    visibility: "limited",
    createdAt: FIXED_DATE,
  });
  const shy = (await db.select().from(users).where(eq(users.usernameLower, "upshy")).get())!;
  await service.create({ owner: { id: shy.id, usernameLower: "upshy" }, name: "upshysecret", isPrivate: true, status: "ready" });

  // The paging profile: 16 public repos (one page of 15 + one row).
  await db.insert(users).values({
    username: "upbulk",
    usernameLower: "upbulk",
    status: "active",
    visibility: "public",
    createdAt: FIXED_DATE,
  });
  const bulk = (await db.select().from(users).where(eq(users.usernameLower, "upbulk")).get())!;
  for (let i = 0; i < 16; i++) {
    await service.create({ owner: { id: bulk.id, usernameLower: "upbulk" }, name: `upbulk-${String(i).padStart(2, "0")}`, isPrivate: false, status: "ready" });
  }

  // The rename pairs: display-cased targets over lower-cased old names.
  for (const [oldName, newName, visibility] of [
    ["upold", "UpNew", "public"],
    ["upoldpriv", "UpNewPriv", "private"],
    ["upoldlim", "UpNewLim", "limited"],
  ] as const) {
    await db.insert(users).values({
      username: newName,
      usernameLower: newName.toLowerCase(),
      status: "active",
      visibility,
      createdAt: FIXED_DATE,
    });
    const target = (await db.select().from(users).where(eq(users.usernameLower, newName.toLowerCase())).get())!;
    await db.insert(userRedirects).values({ lowerName: oldName, redirectUserId: target.id });
  }

  // The org (the tab-discrimination arm — public, so any viewer resolves it).
  if ((await orgs.getOrgByUsername("uporg")) === null) {
    await orgs.createOrg({ name: "uporg", ownerId: pal.id, visibility: "public", now: FIXED_DATE });
  }
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the private/limited profile page CONTENT (beyond wave 7's status ladder) --

describe("the private profile's signed-in rendering (the arms beyond wave 7)", () => {
  it("an anonymous viewer 404-shells; the followed viewer renders the profile with the Private badge", async () => {
    const anon = await get("/uppriv");
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("Page Not Found"); // existence hidden

    const followed = await get("/uppriv", "uppal");
    expect(followed.status).toBe(200);
    const html = await followed.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain('>uppriv<span class="ui large basic horizontal label">Private</span></span>'); // the badge inside the name span
    expect(html).toContain(">Private</span>"); // the avatar-card badge
  });

  it("the followed viewer sees only the PUBLIC rows; the public row wears the Internal badge (private owner)", async () => {
    const followed = await get("/uppriv", "uppal");
    const html = await followed.text();
    expect(html).toContain('href="/uppriv/upexposed"');
    expect(html).not.toContain("/uppriv/upstash"); // the private row never leaks
    expect(html).toContain('<span class="ui basic label">Internal</span>'); // public under a private owner
    expect(html).toContain('<div class="ui small label">1</div>'); // the visible count
  });

  it("the owner and a site admin see both rows (the public one Internal, the private one Private)", async () => {
    for (const viewer of ["uppriv", "upadmin"]) {
      const res = await get("/uppriv", viewer);
      expect(res.status, viewer).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/uppriv/upexposed"');
      expect(html).toContain('href="/uppriv/upstash"');
      expect(html).toContain('<span class="ui basic label">Internal</span>');
      expect(html).toContain('<span class="ui basic label">Private</span>'); // the row badge
      expect(html).toContain('<div class="ui small label">2</div>');
    }
  });

  it("a LIMITED owner's private repo stays hidden from a signed-in stranger (seePrivate is admin/self only)", async () => {
    const res = await get("/upshy", "uppal");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">Limited</span>"); // the avatar-card badge
    expect(html).not.toContain("/upshy/upshysecret"); // the private row never leaks
    expect(html).not.toContain("ui small label"); // zero visible repos → no count label
  });
});

// --- the org home vs user home discrimination ---------------------------------

describe("the org home vs user home discrimination at the shared route", () => {
  it("a mixed-case name resolves to the same user profile (usernameLower), never the org page", async () => {
    const res = await get("/UPGAL");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain(">upgal</span>"); // the STORED display-cased name
    expect(html).not.toContain("page-content organization");
  });

  it("an org name with ?tab=activity still serves the ORG home (org.Home ignores the tab — upstream parity)", async () => {
    const res = await get("/uporg?tab=activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content organization profile"');
    expect(html).not.toContain("page-content user profile");
  });
});

// --- the ?tab=activity arm (the module is unmounted at this pin — the param is inert)

describe("the ?tab=activity arm's rendering (the activity module is unmounted — the param is inert)", () => {
  it("the profile renders the repositories view with only the canonical tab anchor (no dead ?tab= link, no activity DOM)", async () => {
    const res = await get("/upgal?tab=activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user profile"');
    expect(html).toContain('href="/upgal/upopen"'); // the repositories rows, not a feed
    expect(html).not.toContain("data-ref-issue-container"); // feeds.tmpl's container — never leaks
    expect(html).not.toContain("activity-feed");
    expect(html).toContain('class="active item" href="/upgal"'); // the single live tab, canonical
    expect(html).not.toContain("?tab="); // no dead anchor carries the tab
  });

  it("the pager anchors stay canonical under the tab query", async () => {
    const res = await get("/upbulk?tab=activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/upbulk?page=2"'); // Older — no tab carried
    expect(html).not.toContain("?tab=");
  });

  it("the tab never bypasses the visibility ladder or the miss path", async () => {
    const priv = await get("/uppriv?tab=activity");
    expect(priv.status).toBe(404); // anonymous on a private owner — the tab changes nothing
    const nobody = await get("/upnobody?tab=activity");
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toContain("Page Not Found");
  });
});

// --- renamed users through the shared seam (beyond wave 7's public pair) ------

describe("renamed users through the shared seam (the gated-target arms)", () => {
  it("a PRIVATE target 307s for a signed-in viewer; anonymous folds into the miss", async () => {
    const anon = await get("/upoldpriv");
    expect(anon.status).toBe(404); // "must be signed in to see limited or private" — indistinguishable
    expect(await anon.text()).toContain("Page Not Found");

    const signed = await get("/upoldpriv", "uppal");
    expect(signed.status).toBe(307);
    expect(signed.headers.get("location")).toBe("/UpNewPriv");
  });

  it("a LIMITED target: anonymous 404, any signed-in viewer 307s", async () => {
    const anon = await get("/upoldlim");
    expect(anon.status).toBe(404);

    const signed = await get("/upoldlim", "uppal");
    expect(signed.status).toBe(307);
    expect(signed.headers.get("location")).toBe("/UpNewLim");
  });

  it("the location rewrites to the DISPLAY-cased target and preserves a multi-param query; the new name resolves", async () => {
    const redirect = await get("/upold?tab=activity&x=1");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/UpNew?tab=activity&x=1");

    const target = await get("/UpNew");
    expect(target.status).toBe(200);
    expect(await target.text()).toContain(">UpNew</span>");
  });
});

// --- unknown names ------------------------------------------------------------

describe("unknown names (existence never leaks)", () => {
  it("an unknown name 404-shells identically for anonymous and site admin", async () => {
    for (const viewer of [undefined, "upadmin"]) {
      const res = await get("/upnobody", viewer);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Page Not Found");
    }
  });
});

// --- the route claim pin (the owner-home family's parse ↔ registration) -------

describe("the route claim pin (the owner-home family)", () => {
  it("claims exactly the single non-reserved segment; the raw casing survives, encoding decodes", () => {
    expect(parseUiRoute("/upgal")).toEqual({ family: "owner-home", owner: "upgal" });
    expect(handlesUiRoute("/upgal")).toBe(true);
    expect(parseUiRoute("/UPGAL")).toEqual({ family: "owner-home", owner: "UPGAL" }); // resolution folds case
    expect(parseUiRoute("/w%61ve7up")).toEqual({ family: "owner-home", owner: "wave7up" }); // decoded
  });

  it("refuses the top-level literals, the reserved owner names and the .keys/.gpg suffixes (never claimed)", () => {
    for (const path of ["/login", "/logout", "/healthz", "/api", "/assets", "/upgal.keys", "/upgal.gpg"]) {
      expect(parseUiRoute(path), path).toBeNull();
      expect(handlesUiRoute(path), path).toBe(false);
    }
  });

  it("the feed suffixes claim the owner into the window-2e families, not the profile", () => {
    expect(parseUiRoute("/upgal.rss")).toEqual({ family: "user-feed-rss", owner: "upgal" });
    expect(parseUiRoute("/upgal.atom")).toEqual({ family: "user-feed-atom", owner: "upgal" });
  });

  it("a second segment is never the profile (the repo-home family claims /{owner}/{repo})", () => {
    expect(parseUiRoute("/upgal/uprepo")).toEqual({ family: "home", owner: "upgal", repo: "uprepo", refSuffix: null });
    expect(parseUiRoute("/upgal/uprepo/extra")).toBeNull(); // a junk deeper tail stays unclaimed (the engine's 404)
  });
});
