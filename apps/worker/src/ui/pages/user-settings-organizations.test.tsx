/**
 * The user settings ORGANIZATIONS page's tests (the bench-row UNMOUNTED
 * module — the repo-settings-wiki.test.tsx harness): the loader over the
 * landed `GET /user/orgs` self-list read, the leave write over the landed
 * `removeMember` seam (RemoveOrgUser's port — the last-owner guard
 * included), the form parse, and the DOM contract — hono/jsx
 * renderToString, the module driven directly. The module is MOUNTED since
 * the user-settings window (0c2b151 — GET /user/settings/organization +
 * POST /user/settings/organization/leave at ui/index.ts, the wave-12
 * tab-prologue pair), so the deferred-test matrix also drives the real
 * routes (the appearance matrix's minted-session route-level pattern):
 * the leave outcomes' exact 303 targets with the ?error=last-owner flash
 * read back off the follow-up GET, the pager shapes off the loader's more
 * flag (page 2 empty for small sets), the guard-first cross-origin 403,
 * the singular-path pin (the plural spelling stays unclaimed → the
 * engine's 404), and the empty state through the mounted GET. Orgs seed
 * through the landed `createOrg` service (the orgs.test.ts bootstrap:
 * applyOrgsDdl + resetOrgTables).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { OrgService } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import {
  applyUserOrgsLeave,
  loadUserOrgsSettings,
  parseUserOrgsLeaveForm,
  renderUserOrgsSettingsPage,
  UserOrgsSettingsPage,
  userOrgsSettingsLocale,
  UserOrgsSettingsNav,
  USER_ORGS_PAGE_SIZE,
} from "./user-settings-organizations";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

beforeAll(async () => {
  await applyOrgsDdl();
});

beforeEach(resetOrgTables);

/** The world each DOM/leave test seeds: alice (the viewer), one org where a
 *  second owner lets her be a plain member, one org where she is the sole
 *  owner (the last-owner guard). */
async function seedWorld(): Promise<{ aliceId: number; viewer: Viewer; ctx: UiContext; memberOrg: string; ownerOrg: string }> {
  const orgs = new OrgService(env.DB);
  const alice = await seedVerifiedUser({ username: "alice" });
  const bob = await seedVerifiedUser({ username: "bob" });
  const memberOrg = await orgs.createOrg({
    name: "Alphatech",
    ownerId: bob.id,
    fullName: "Alpha Tech",
    description: "Alpha description",
  });
  // Alice joins as a plain HIDDEN member (is_public 0 — the self-list lists
  // non-public memberships; the raw insert is fixture scratch, the write
  // under test is removeMember). The counter mirrors the maintained value.
  await env.DB.prepare(
    "INSERT INTO org_members (org_id, user_id, is_public, role, created_at) VALUES (?, ?, 0, 'member', unixepoch())",
  )
    .bind(memberOrg.id, alice.id)
    .run();
  await env.DB.prepare("UPDATE users SET num_members = 2 WHERE id = ?").bind(memberOrg.id).run();
  await orgs.createOrg({
    name: "Zetacorp",
    ownerId: alice.id,
    description: null,
  });
  const viewer: Viewer = { kind: "user", id: alice.id, username: "alice", isAdmin: false };
  return { aliceId: alice.id, viewer, ctx: { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) }, memberOrg: "Alphatech", ownerOrg: "Zetacorp" };
}

// --- the loader ---------------------------------------------------------------

describe("loadUserOrgsSettings (the GET /user/orgs self-list read)", () => {
  it("lists every membership ordered by username_lower, non-public included", async () => {
    const { aliceId, memberOrg, ownerOrg } = await seedWorld();
    const data = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams());
    // "alphatech" < "zetacorp" in lower-case order (the service's
    // username_lower ordering; the rows carry their display case).
    expect(data.orgs.map((org) => org.username)).toEqual([memberOrg, ownerOrg]);
    // The hidden membership (is_public 0) is listed — upstream's
    // IncludeVisibility: private self-list shape.
    expect(data.orgs[0]?.fullName).toBe("Alpha Tech");
    expect(data.orgs[0]?.description).toBe("Alpha description");
    expect(data.page).toBe(1);
    expect(data.more).toBe(false);
  });

  it("a viewer with no memberships loads the empty page (the orgs_none state)", async () => {
    const bob = await seedVerifiedUser({ username: "bob" });
    const data = await loadUserOrgsSettings(env.DB, bob.id, new URLSearchParams());
    expect(data.orgs).toEqual([]);
    expect(data.more).toBe(false);
  });

  it("pages at UserPagingNum=50 and computes the Older flag", async () => {
    const { aliceId } = await seedWorld();
    // 49 more raw org+membership pairs on top of the seeded 2 → 51 total.
    for (let i = 0; i < USER_ORGS_PAGE_SIZE - 1; i++) {
      const lower = `bulk${String(i).padStart(2, "0")}`;
      const inserted = await env.DB.prepare(
        "INSERT INTO users (username, username_lower, type, created_at) VALUES (?, ?, 'org', unixepoch())",
      )
        .bind(lower, lower)
        .run();
      const orgId = inserted.meta.last_row_id;
      if (typeof orgId !== "number" || orgId === 0) throw new Error("bulk org seed failed");
      await env.DB.prepare(
        "INSERT INTO org_members (org_id, user_id, is_public, role, created_at) VALUES (?, ?, 1, 'member', unixepoch())",
      )
        .bind(orgId, aliceId)
        .run();
    }
    const page1 = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams());
    expect(page1.orgs.length).toBe(USER_ORGS_PAGE_SIZE);
    expect(page1.more).toBe(true);
    const page2 = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams("page=2"));
    expect(page2.orgs.length).toBe(1);
    expect(page2.more).toBe(false);
    // A page past the end is the empty page (parsePageNumber keeps it >= 1).
    const page3 = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams("page=3"));
    expect(page3.orgs).toEqual([]);
    expect(page3.page).toBe(3);
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseUserOrgsLeaveForm (upstream's ?uid= + OrganisationLink as fields)", () => {
  it("parses the numeric uid and the org segment", () => {
    const form = parseUserOrgsLeaveForm(new URLSearchParams({ uid: "42", org: "Alphatech" }));
    expect(form).toEqual({ uid: 42, org: "Alphatech" });
  });

  it("an absent or non-numeric uid parses 0; an absent org parses empty", () => {
    expect(parseUserOrgsLeaveForm(new URLSearchParams())).toEqual({ uid: 0, org: "" });
    expect(parseUserOrgsLeaveForm(new URLSearchParams({ uid: "x", org: "a" })).uid).toBe(0);
  });
});

// --- the write -------------------------------------------------------------------

describe("applyUserOrgsLeave (MembersAction case leave over OrgService.removeMember)", () => {
  it("a plain member leaves — outcome left, membership gone, counter decremented", async () => {
    const { aliceId, memberOrg } = await seedWorld();
    const org = await new OrgService(env.DB).getOrgByUsername(memberOrg);
    if (org === null) throw new Error("fixture org missing");
    const result = await applyUserOrgsLeave(env.DB, aliceId, { uid: aliceId, org: memberOrg });
    expect(result).toEqual({ outcome: "left" });
    const membership = await new OrgService(env.DB).getMembership(org.id, aliceId);
    expect(membership).toBeNull();
    const raw = await env.DB.prepare("SELECT num_members FROM users WHERE id = ?").bind(org.id).first<{ num_members: number }>();
    expect(raw?.num_members).toBe(1);
  });

  it("the sole owner cannot leave — outcome last-owner, the row survives (§4.3 guard)", async () => {
    const { aliceId, ownerOrg } = await seedWorld();
    const org = await new OrgService(env.DB).getOrgByUsername(ownerOrg);
    if (org === null) throw new Error("fixture org missing");
    const result = await applyUserOrgsLeave(env.DB, aliceId, { uid: aliceId, org: ownerOrg });
    expect(result).toEqual({ outcome: "last-owner" });
    const membership = await new OrgService(env.DB).getMembership(org.id, aliceId);
    expect(membership).not.toBeNull();
  });

  it("an org without the viewer's membership is the silent no-op", async () => {
    const { aliceId } = await seedWorld();
    const outsider = await new OrgService(env.DB).createOrg({ name: "Outsider", ownerId: aliceId });
    await env.DB.prepare("DELETE FROM org_members WHERE org_id = ?").bind(outsider.id).run();
    const result = await applyUserOrgsLeave(env.DB, aliceId, { uid: aliceId, org: "Outsider" });
    expect(result).toEqual({ outcome: "not-a-member" });
  });

  it("a missing org row is the not-a-member posture (upstream's OrgAssignment 404)", async () => {
    const { aliceId } = await seedWorld();
    const result = await applyUserOrgsLeave(env.DB, aliceId, { uid: aliceId, org: "ghost" });
    expect(result).toEqual({ outcome: "not-a-member" });
  });

  it("the uid field is accepted-and-ignored — the removed membership is the viewer's own", async () => {
    const { aliceId, memberOrg } = await seedWorld();
    const result = await applyUserOrgsLeave(env.DB, aliceId, { uid: 999999, org: memberOrg });
    expect(result).toEqual({ outcome: "left" });
    const org = await new OrgService(env.DB).getOrgByUsername(memberOrg);
    if (org === null) throw new Error("fixture org missing");
    expect(await new OrgService(env.DB).getMembership(org.id, aliceId)).toBeNull();
    expect(await new OrgService(env.DB).getMembership(org.id, 999999)).toBeNull();
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the organizations settings DOM (organizations.tmpl at the pin)", () => {
  it("renders the header, the New Organization button, and one row per membership", async () => {
    const { aliceId, ctx, memberOrg, ownerOrg } = await seedWorld();
    const data = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams());
    const html = renderToString(<UserOrgsSettingsPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain("user settings organization"); // the §2.4.1 discriminator
    expect(html).toContain(userOrgsSettingsLocale.orgs); // "Manage Organizations"
    expect(html).toContain('href="/org/create"'); // the header button (gate unreachable at the landed tier)
    expect(html).toContain(userOrgsSettingsLocale.new_orga);
    // shared/user/name: the muted HomeLink anchor with the display name —
    // HomeLink keeps the display-case username (upstream's own convention).
    expect(html).toContain('<a class="text muted" href="/Alphatech">Alpha Tech</a>');
    expect(html).toContain('<a class="text muted" href="/Zetacorp">Zetacorp</a>');
    expect(html).toContain("Alpha description");
    expect(html).not.toContain("ghost");
    expect(memberOrg).toBe("Alphatech"); // the fixture names the assertions above read
    expect(ownerOrg).toBe("Zetacorp");
    // The full-document render path matches the component path.
    expect(renderUserOrgsSettingsPage(ctx, data, { error: null })).toContain('href="/Alphatech"');
  });

  it("renders the leave disclosure with the live form (no modal chrome, no dead controls)", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams());
    const html = renderToString(<UserOrgsSettingsPage ctx={ctx} data={data} error={null} />);
    // organizations.tmpl:41-51's #leave-organization dialog reduced to the
    // <details> disclosure wrapping the same form (the org-settings
    // danger-row reduction).
    expect(html).toContain("<details");
    expect(html).toContain('action="/user/settings/organization/leave"');
    expect(html).toContain('method="post"');
    expect(html).toContain(`name="uid" value="${aliceId}"`);
    expect(html).toContain('name="org" value="Alphatech"');
    expect(html).toContain("Leave Alpha Tech?"); // leave.detail with the display name
    expect(html).toContain(userOrgsSettingsLocale.leave);
    // The JS chrome is not reproduced; every control stays live.
    expect(html).not.toContain("modal-dialog");
    expect(html).not.toContain("show-modal");
    expect(html).not.toContain("data-modal");
    expect(html).not.toContain("form-fetch-action");
  });

  it("renders the empty state when the viewer holds no memberships", async () => {
    const bob = await seedVerifiedUser({ username: "bob" });
    const viewer: Viewer = { kind: "user", id: bob.id, username: "bob", isAdmin: false };
    const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
    const data = await loadUserOrgsSettings(env.DB, bob.id, new URLSearchParams());
    const html = renderToString(<UserOrgsSettingsPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(userOrgsSettingsLocale.orgs_none);
    expect(html).not.toContain("item-trailing");
  });

  it("the ?error=last-owner flash renders the upstream negative message", async () => {
    const { aliceId, ctx } = await seedWorld();
    const data = await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams());
    const html = renderToString(<UserOrgsSettingsPage ctx={ctx} data={data} error="last-owner" />);
    expect(html).toContain('class="ui negative message"');
    // renderToString HTML-escapes the locale string's apostrophes — assert
    // the un-escaped tail.
    expect(html).toContain("must be at least one owner for an organization.");
  });

  it("renders the Newer/Older pager off the loaded page state (inside the non-empty branch, upstream's {{if .Orgs}})", async () => {
    const { aliceId, ctx } = await seedWorld();
    const fakeOrg = (await loadUserOrgsSettings(env.DB, aliceId, new URLSearchParams())).orgs[0];
    if (fakeOrg === undefined) throw new Error("fixture org missing");
    const paged = renderToString(
      <UserOrgsSettingsPage ctx={ctx} data={{ orgs: [fakeOrg], page: 2, more: true }} error={null} />,
    );
    expect(paged).toContain("ui borderless pagination menu");
    expect(paged).toContain('href="/user/settings/organization?page=1"');
    expect(paged).toContain('href="/user/settings/organization?page=3"');
    const plain = renderToString(
      <UserOrgsSettingsPage ctx={ctx} data={{ orgs: [fakeOrg], page: 1, more: false }} error={null} />,
    );
    expect(plain).not.toContain("pagination menu");
  });

  it("the nav scaffolding renders the Profile item plus Organizations active", () => {
    const html = renderToString(<UserOrgsSettingsNav />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/user/settings"');
    expect(html).toContain('class="active item" href="/user/settings/organization"');
    expect(html).toContain(userOrgsSettingsLocale.organization);
  });

  it("throws without a signed-in viewer (the settings pages' self-scoped contract)", async () => {
    const { ctx } = await seedWorld();
    const anonCtx: UiContext = { viewer: { kind: "anonymous" }, origin: ORIGIN, assets: ctx.assets };
    expect(() =>
      renderToString(<UserOrgsSettingsPage ctx={anonCtx} data={{ orgs: [], page: 1, more: false }} error={null} />),
    ).toThrow("UserOrgsSettingsPage requires a signed-in viewer");
  });
});

// --- the mounted-route harness (0c2b151; the appearance-matrix pattern) ------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → load → render, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The viewer's minted session cookie header (the real mintSession path,
 *  minted per request — the beforeEach users wipe cascades the sessions
 *  table, so a cross-test cache would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The leave POST through the real route: urlencoded body, the browser's
 *  same-origin Origin header (the §2.8 guard's happy path), the viewer's
 *  minted session cookie. */
async function leavePost(userId: number, fields: Record<string, string>): Promise<Response> {
  return fetchUi("/user/settings/organization/leave", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
      cookie: await sessionHeader(userId),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A signed-in GET of the settings page through the real route. */
async function getPage(userId: number, path = "/user/settings/organization"): Promise<Response> {
  return fetchUi(path, { headers: { cookie: await sessionHeader(userId) } });
}

/** The org's raw num_members counter (the leave write's maintained batch). */
async function numMembersOf(orgUsername: string): Promise<number | null> {
  const raw = await env.DB.prepare("SELECT num_members FROM users WHERE username = ?")
    .bind(orgUsername)
    .first<{ num_members: number }>();
  return raw?.num_members ?? null;
}

/** The membership row for (orgId, userId), or null. */
async function membershipOf(orgId: number, userId: number): Promise<unknown> {
  return new OrgService(env.DB).getMembership(orgId, userId);
}

/** The fixture org row, or a thrown failure (the loader test's posture). */
async function orgRowOrThrow(orgUsername: string): Promise<{ id: number }> {
  const org = await new OrgService(env.DB).getOrgByUsername(orgUsername);
  if (org === null) throw new Error("fixture org missing");
  return org;
}

// --- the mounted routes (0c2b151: the GET + the leave POST) -----------------------

describe("the mounted routes (GET /user/settings/organization + POST .../leave)", () => {
  it("303s an anonymous GET onto the login round-trip", async () => {
    const res = await fetchUi("/user/settings/organization");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fuser%2Fsettings%2Forganization");
  });

  it("303s an anonymous leave POST onto the login round-trip too (same-origin body, then the signed-in gate)", async () => {
    const res = await fetchUi("/user/settings/organization/leave", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://test.local",
      },
      body: new URLSearchParams({ uid: "1", org: "Alphatech" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fuser%2Fsettings%2Forganization%2Fleave");
  });

  it("renders the signed-in GET at 200 with the discriminator and the membership rows", async () => {
    const { aliceId, memberOrg } = await seedWorld();
    const res = await getPage(aliceId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user settings organization"); // the §2.4.1 pageClass
    expect(html).toContain(`href="/${memberOrg}"`); // the row's HomeLink
  });

  it("a leave POST that removes the membership 303s onto / (upstream's JSONRedirect home) with the write applied", async () => {
    const { aliceId, memberOrg } = await seedWorld();
    const res = await leavePost(aliceId, { uid: String(aliceId), org: memberOrg });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const org = await orgRowOrThrow(memberOrg);
    expect(await membershipOf(org.id, aliceId)).toBeNull();
    expect(await numMembersOf(memberOrg)).toBe(1); // bob remains
  });

  it("a leave POST without the membership 303s back silently (the plain target, no ?error=)", async () => {
    const { aliceId } = await seedWorld();
    const res = await leavePost(aliceId, { uid: String(aliceId), org: "ghost" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/organization");
  });

  it("a last-owner leave POST 303s onto ?error=last-owner, keeps the row, and the follow-up GET renders the flash banner", async () => {
    const { aliceId, ownerOrg } = await seedWorld();
    const res = await leavePost(aliceId, { uid: String(aliceId), org: ownerOrg });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/organization?error=last-owner");
    const org = await orgRowOrThrow(ownerOrg);
    expect(await membershipOf(org.id, aliceId)).not.toBeNull(); // the §4.3 guard holds
    // The flash reduction: the 303's error param rides the round-trip; the
    // page GET a browser would follow with renders the upstream negative
    // message (upstream's form.last_org_owner JSONError text).
    const page = await getPage(aliceId, "/user/settings/organization?error=last-owner");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("must be at least one owner for an organization.");
  });

  it("any other ?error= value parses to no banner (the handler's exact-match reduction)", async () => {
    const { aliceId } = await seedWorld();
    const page = await getPage(aliceId, "/user/settings/organization?error=whatever");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("ui negative message");
  });

  it("rejects a cross-origin leave POST with 403 before any write (sameOriginGuard first)", async () => {
    const { aliceId, memberOrg } = await seedWorld();
    const res = await fetchUi("/user/settings/organization/leave", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: await sessionHeader(aliceId),
      },
      body: new URLSearchParams({ uid: String(aliceId), org: memberOrg }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    const org = await orgRowOrThrow(memberOrg);
    expect(await membershipOf(org.id, aliceId)).not.toBeNull(); // nothing was written
  });

  it("serves ?page=2 for a small set as the empty state with no pager (page 2 holds no rows)", async () => {
    const { aliceId, memberOrg } = await seedWorld();
    const res = await getPage(aliceId, "/user/settings/organization?page=2");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(userOrgsSettingsLocale.orgs_none); // the empty branch, not a 404
    expect(html).not.toContain("pagination menu"); // more=false, page=2 → pager needs the non-empty branch
    expect(html).not.toContain(`href="/${memberOrg}"`); // page 1's row does not leak
  });

  it("shapes the Newer/Older pager off the real loader more flag (51 memberships: page 1 Older-only, page 2 Newer-only)", async () => {
    const { aliceId } = await seedWorld();
    // 49 more raw org+membership pairs on top of the seeded 2 → 51 total
    // (the loader test's bulk loop, driven through the mounted GET).
    for (let i = 0; i < USER_ORGS_PAGE_SIZE - 1; i++) {
      const lower = `bulk${String(i).padStart(2, "0")}`;
      const inserted = await env.DB.prepare(
        "INSERT INTO users (username, username_lower, type, created_at) VALUES (?, ?, 'org', unixepoch())",
      )
        .bind(lower, lower)
        .run();
      const orgId = inserted.meta.last_row_id;
      if (typeof orgId !== "number" || orgId === 0) throw new Error("bulk org seed failed");
      await env.DB.prepare(
        "INSERT INTO org_members (org_id, user_id, is_public, role, created_at) VALUES (?, ?, 1, 'member', unixepoch())",
      )
        .bind(orgId, aliceId)
        .run();
    }
    const page1 = await getPage(aliceId);
    const html1 = await page1.text();
    expect(html1).toContain('<span class="navigation_label">Older</span>');
    expect(html1).toContain('href="/user/settings/organization?page=2"');
    expect(html1).not.toContain(">Newer<"); // page 1 carries no Newer link
    const page2 = await getPage(aliceId, "/user/settings/organization?page=2");
    const html2 = await page2.text();
    expect(html2).toContain('<span class="navigation_label">Newer</span>');
    expect(html2).toContain('href="/user/settings/organization?page=1"');
    expect(html2).not.toContain(">Older<"); // more=false past the tail
    // Page 2 lists the tail row only (zetacorp sorts last of the 51).
    expect(html2).toContain('href="/Zetacorp"');
    expect(html2).not.toContain('href="/Alphatech"');
  });

  it("renders the empty state through the mounted GET for a viewer with no memberships", async () => {
    const bob = await seedVerifiedUser({ username: "bob" });
    const res = await getPage(bob.id);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(userOrgsSettingsLocale.orgs_none);
    expect(html).not.toContain("item-trailing"); // no membership rows
    expect(html).not.toContain("pagination menu");
  });
});

// --- the singular-path pin (web.go:740's singular route, the plural template) ------

describe("the singular-path pin (GET /user/settings/organizations stays unclaimed)", () => {
  it("parses exactly the singular GET and the leave shapes", () => {
    expect(parseUiRoute("/user/settings/organization")).toEqual({ family: "user-settings-organizations", id: null });
    expect(parseUiRoute("/user/settings/organization/leave")).toEqual({
      family: "user-settings-organizations-leave",
      id: null,
    });
  });

  it("the plural spelling is unclaimed — parse null, dispatcher hands it to the engine, the router does not absorb it", async () => {
    // The parse discipline: the /user/settings/* claim enumerates exact
    // tails only (the parse block's `return null`), so the plural spelling
    // is unclaimed and handlesUiRoute (§2.2's dispatcher gate) passes it to
    // the engine — whose reserved-owner "user" refusal answers the 404
    // (upstream's unregistered-route answer for this slice). The uiRouter's
    // own reach matches the parse claim: no registration absorbs the shape,
    // so a direct fetch 404s (the registered-exactly-as-parsed invariant).
    expect(parseUiRoute("/user/settings/organizations")).toBeNull();
    expect(handlesUiRoute("/user/settings/organizations")).toBe(false);
    expect((await fetchUi("/user/settings/organizations")).status).toBe(404);
  });
});
