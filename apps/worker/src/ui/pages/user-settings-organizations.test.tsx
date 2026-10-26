/**
 * The user settings ORGANIZATIONS page's tests (the bench-row UNMOUNTED
 * module — the repo-settings-wiki.test.tsx harness): the loader over the
 * landed `GET /user/orgs` self-list read, the leave write over the landed
 * `removeMember` seam (RemoveOrgUser's port — the last-owner guard
 * included), the form parse, and the DOM contract — hono/jsx
 * renderToString, the module driven directly (no route yet, the HANDOFF
 * NOTE in the module header). Orgs seed through the landed `createOrg`
 * service (the orgs.test.ts bootstrap: applyOrgsDdl + resetOrgTables).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { OrgService } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
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
