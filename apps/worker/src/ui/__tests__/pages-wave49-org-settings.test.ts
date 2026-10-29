/**
 * Wave-49 org settings + team edit — the parity survey's re-ranked #1
 * (upstream web.go:1011-1013's team edit/delete and web.go:1017-1092's
 * /{org}/settings group) mounted in index.ts over pages/org-settings.tsx:
 *
 * - `GET+POST /{org}/settings` — the options page (org/settings/options.tmpl)
 *   riding the landed orgEdit arm (`editOrgProfile`);
 * - `POST /{org}/settings/{avatar,avatar/delete,rename,delete,visibility}` —
 *   the write arms over the landed avatar store + renameOrg/orgDelete/
 *   orgEdit(visibility) ops;
 * - `GET+POST /{org}/teams/{id}/edit` + `POST /{org}/teams/{id}/delete` —
 *   new.tmpl's edit arm over the landed orgEditTeam/orgDeleteTeam arms;
 * - the entry-link hunk: the team detail sidebar's Settings button
 *   (org/team/sidebar.tmpl:90, org-teams.tsx).
 *
 * Same harness posture as pages-wave12 (the org-page conventions): the
 * router driven directly with the synthetic ASSETS manifest; orgs/teams
 * seed through the LANDED services. Fixture orgs `setorg` (one repo, two
 * teams — blanket + units) and `delorg`/`ownerlock` (the rename/delete and
 * last-owner-refusal arms).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { orgMembers, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { TeamsService, type TeamRecord } from "../../api/routes/org-teams";
import { avatarExists } from "../../services/avatars";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const formPost = (path: string, body: Record<string, string>, cookie?: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(body).toString(),
});

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

/** A minimal valid PNG (1x1) — the avatar processor's accepted input. */
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

const avatarPost = (path: string, cookie: string, file: boolean): RequestInit => {
  const form = new FormData();
  if (file) form.set("avatar", new Blob([PNG_1X1], { type: "image/png" }), "avatar.png");
  return { method: "POST", headers: { origin: "https://test.local", cookie: `${SESSION_COOKIE_NAME}=${cookie}` }, body: form };
};

// --- fixtures -----------------------------------------------------------------

interface Wave49Fixture {
  ownerCookie: string; // setorg's + delorg's + ownerlock's owner
  memberCookie: string; // a plain setorg member (non-owner)
  adminCookie: string; // site admin
  orgId: number;
  delOrgId: number;
  lockOrgId: number;
  devTeamId: number; // blanket write team
  unitTeamId: number; // per-unit map team
  lockTeamId: number; // ownerlock's team (the refusal arm)
}

let wave49Fixture: Wave49Fixture | null = null;

async function ensureWave49Fixtures(): Promise<Wave49Fixture> {
  if (wave49Fixture !== null) return wave49Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);
  const repoService = new RepoService(env.DB);

  for (const extra of [
    { username: "wave49owner", isAdmin: false },
    { username: "wave49member", isAdmin: false },
    { username: "wave49admin", isAdmin: true },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username, isAdmin: extra.isAdmin });
    }
  }
  const owner = (await db.select().from(users).where(eq(users.usernameLower, "wave49owner")).get())!;
  const member = (await db.select().from(users).where(eq(users.usernameLower, "wave49member")).get())!;

  let org = await orgs.getOrgByUsername("setorg");
  if (org === null) {
    org = await orgs.createOrg({ name: "setorg", ownerId: owner.id, visibility: "public", now: t(0) });
    await repoService.create({ owner: { id: org.id, usernameLower: "setorg" }, name: "repo-one", isPrivate: false, status: "ready" });
    await orgs.addMember(org.id, member.id, { now: t(1) });
  }
  org = (await orgs.getOrgByUsername("setorg"))!;

  let delOrg = await orgs.getOrgByUsername("delorg");
  if (delOrg === null) delOrg = await orgs.createOrg({ name: "delorg", ownerId: owner.id, visibility: "public", now: t(0) });
  let lockOrg = await orgs.getOrgByUsername("ownerlock");
  if (lockOrg === null) lockOrg = await orgs.createOrg({ name: "ownerlock", ownerId: owner.id, visibility: "public", now: t(0) });

  const service = new TeamsService(env.DB);
  let devTeam = await service.getTeamByName(org.id, "Dev Team");
  if (devTeam === null) {
    devTeam = await service.createTeam(org, { name: "Dev Team", permission: "write", description: "Ships the settings." });
    await service.addTeamMember(devTeam, member.id);
  }
  let unitTeam = await service.getTeamByName(org.id, "Unit Team");
  if (unitTeam === null) {
    // The per-unit shape: a units_map team (authorize none, overrides stored).
    unitTeam = await service.createTeam(org, { name: "Unit Team", units_map: { "repo.code": "read" } });
  }
  let lockTeam = await service.getTeamByName(lockOrg.id, "Lock Team");
  if (lockTeam === null) {
    lockTeam = await service.createTeam(lockOrg, { name: "Lock Team", permission: "read" });
    // The org's SOLE owner rides this team — its delete would leave the org
    // ownerless (the landed deleteTeam's LastOrgOwnerError guard).
    await service.addTeamMember(lockTeam, owner.id);
  }

  wave49Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    memberCookie: await mintSession(env.DB, member.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave49admin")).get())!.id),
    orgId: org.id,
    delOrgId: delOrg.id,
    lockOrgId: lockOrg.id,
    devTeamId: devTeam.id,
    unitTeamId: unitTeam.id,
    lockTeamId: lockTeam.id,
  };
  return wave49Fixture;
}

beforeAll(async () => {
  await ensureWave49Fixtures();
});

async function teamById(id: number): Promise<TeamRecord> {
  const team = await new TeamsService(env.DB).getTeamById(id);
  if (team === null) throw new Error(`fixture team ${id} vanished`);
  return team;
}

// --- the parser claims ----------------------------------------------------------

describe("wave-49 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the settings shapes", () => {
    expect(parseUiRoute("/acme/settings")).toEqual({ family: "org-settings", owner: "acme" });
    expect(parseUiRoute("/acme/settings/avatar")).toEqual({ family: "org-settings-avatar", owner: "acme" });
    expect(parseUiRoute("/acme/settings/avatar/delete")).toEqual({ family: "org-settings-avatar-delete", owner: "acme" });
    expect(parseUiRoute("/acme/settings/rename")).toEqual({ family: "org-settings-rename", owner: "acme" });
    expect(parseUiRoute("/acme/settings/delete")).toEqual({ family: "org-settings-delete", owner: "acme" });
    expect(parseUiRoute("/acme/settings/visibility")).toEqual({ family: "org-settings-visibility", owner: "acme" });
    expect(handlesUiRoute("/acme/settings")).toBe(true);
  });

  it("leaves the unclaimed tabs and deeper junk with the engine", () => {
    // The labels/... tabs are separate upstream pages still not
    // claimed; every other tail stays engine-owned. (Wave 53 lifted the
    // hooks tab out of this set — pages/org-settings-hooks.tsx — so
    // /acme/settings/hooks now parses to its own family.)
    expect(parseUiRoute("/acme/settings/hooks")).toEqual({ family: "org-settings-hooks", owner: "acme" });
    expect(parseUiRoute("/acme/settings/labels")).toBeNull();
    // The R20-a applications arm (pages/org-settings-applications.tsx)
    // lifted the applications tab out of this set — the stale toBeNull pin
    // updated to the claimed shapes (the window-2b blocked_users precedent).
    expect(parseUiRoute("/acme/settings/applications")).toEqual({ family: "org-settings-applications", owner: "acme" });
    expect(parseUiRoute("/acme/settings/applications/oauth2")).toEqual({
      family: "org-settings-applications-create",
      owner: "acme",
    });
    expect(parseUiRoute("/acme/settings/applications/oauth2/7/delete")).toEqual({
      family: "org-settings-applications-delete",
      owner: "acme",
      id: 7,
    });
    // The show/edit + regenerate_secret shapes stay unclaimed (no landed
    // edit page — the module header).
    expect(parseUiRoute("/acme/settings/applications/oauth2/7")).toBeNull();
    expect(parseUiRoute("/acme/settings/applications/oauth2/7/regenerate_secret")).toBeNull();
    // Window-2b (4f2805f) mounted the blocked-users tab — the stale
    // toBeNull pin updated to the claimed shape (the org-settings matrix's
    // escalation).
    expect(parseUiRoute("/acme/settings/blocked_users")).toEqual({ family: "org-settings-blocked", owner: "acme" });
    expect(parseUiRoute("/acme/settings/audit_logs")).toBeNull();
    expect(parseUiRoute("/acme/settings/rename/extra")).toBeNull();
    expect(parseUiRoute("/acme/settings/")).toEqual({ family: "org-settings", owner: "acme" });
  });

  it("claims the team edit/delete shapes (positive integers only)", () => {
    expect(parseUiRoute("/acme/teams/7/edit")).toEqual({ family: "org-team-edit", owner: "acme", id: 7 });
    expect(parseUiRoute("/acme/teams/007/edit")).toEqual({ family: "org-team-edit", owner: "acme", id: 7 });
    expect(parseUiRoute("/acme/teams/7/delete")).toEqual({ family: "org-team-delete", owner: "acme", id: 7 });
    expect(parseUiRoute("/acme/teams/new/edit")).toBeNull();
    expect(parseUiRoute("/acme/teams/not-a-number/edit")).toBeNull();
  });

  it("shadows a repository named 'settings' exactly like upstream's route order", () => {
    // The require-owner /{org} group registers ahead of :1292's
    // /{username}/{reponame} — a repo named "settings" is shadowed for every
    // viewer; a user owner 404-shells at resolve time.
    expect(parseUiRoute("/alice/settings")).toEqual({ family: "org-settings", owner: "alice" });
  });
});

// --- the gate (the shared org-teams prologue) ------------------------------------

describe("GET /{org}/settings (the requireOrgOwnership posture)", () => {
  it("303s an anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/setorg/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fsetorg%2Fsettings");
  });

  it("404-shells a signed-in non-member, a plain member and a user owner", async () => {
    const fixture = await ensureWave49Fixtures();
    const pal = await fetchUi("/setorg/settings", withCookie(fixture.memberCookie));
    expect(pal.status).toBe(404);
    // A USER namespace: the org resolution's type gate misses → the shell.
    const userOwner = await fetchUi("/wave49member/settings", withCookie(fixture.memberCookie));
    expect(userOwner.status).toBe(404);
  });

  it("answers the owner and a site admin with the options page", async () => {
    const fixture = await ensureWave49Fixtures();
    for (const cookie of [fixture.ownerCookie, fixture.adminCookie]) {
      const res = await fetchUi("/setorg/settings", withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("page-content organization settings options");
      // The options form's fields with the stored values.
      expect(html).toContain('name="full_name"');
      expect(html).toContain('name="repo_admin_change_team_access"');
      expect(html).toContain('action="/setorg/settings"');
      // The live navbar items (Options active; Hooks onto the wave-53 page;
      // Labels onto the landed wave-14 page — the URL divergence).
      expect(html).toContain('<a class="active item" href="/setorg/settings">');
      expect(html).toContain('<a class="item" href="/setorg/settings/hooks">');
      expect(html).toContain('<a class="item" href="/setorg/labels">');
      // The danger zone's three rows, each a <details> form.
      expect(html).toContain("Danger Zone");
      expect(html).toContain('action="/setorg/settings/visibility"');
      expect(html).toContain('action="/setorg/settings/rename"');
      expect(html).toContain('action="/setorg/settings/delete"');
      // The avatar pair.
      expect(html).toContain('action="/setorg/settings/avatar"');
      expect(html).toContain('formaction="/setorg/settings/avatar/delete"');
    }
  });

  it("307s a renamed org (the shared resolve seam)", async () => {
    const fixture = await ensureWave49Fixtures();
    // ownerlock is NOT renamed — use the seam's shape with the settings path.
    const res = await fetchUi("/ownerlock/settings?q=x", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
  });
});

// --- the options + avatar + visibility writes ------------------------------------

describe("POST /{org}/settings (the options write over the landed orgEdit arm)", () => {
  it("applies the form fields and clears on empty (the Go empty-pointer semantics)", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi(
      "/setorg/settings",
      formPost("/setorg/settings", {
        full_name: "Settings Org",
        email: "contact@setorg.example",
        description: "The wave-49 fixture org.",
        website: "https://setorg.example",
        location: "The workerd",
        repo_admin_change_team_access: "on",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/setorg/settings");

    const org = (await new OrgService(env.DB).getOrgByUsername("setorg"))!;
    expect(org.fullName).toBe("Settings Org");
    expect(org.email).toBe("contact@setorg.example");
    expect(org.description).toBe("The wave-49 fixture org.");
    expect(org.website).toBe("https://setorg.example");
    expect(org.location).toBe("The workerd");
    expect(org.repoAdminChangeTeamAccess).toBe(true);

    // The unchecked checkbox posts ABSENT — false, not keep.
    await fetchUi("/setorg/settings", formPost("/setorg/settings", { full_name: "Settings Org" }, fixture.ownerCookie));
    const cleared = (await new OrgService(env.DB).getOrgByUsername("setorg"))!;
    expect(cleared.repoAdminChangeTeamAccess).toBe(false);
    expect(cleared.description).toBe("");
    // The re-rendered page carries the fresh values.
    const page = await fetchUi("/setorg/settings", withCookie(fixture.ownerCookie));
    expect(await page.text()).toContain('value="Settings Org"');
  });

  it("rejects a cross-origin post (the §2.8 guard)", async () => {
    const fixture = await ensureWave49Fixtures();
    const res = await fetchUi("/setorg/settings", formPost("/setorg/settings", { full_name: "x" }, fixture.ownerCookie, "https://evil.example"));
    expect(res.status).toBe(403);
  });

  it("keeps the member gate on the POST arm", async () => {
    const fixture = await ensureWave49Fixtures();
    const res = await fetchUi("/setorg/settings", formPost("/setorg/settings", { full_name: "x" }, fixture.memberCookie));
    expect(res.status).toBe(404);
  });
});

describe("POST /{org}/settings/avatar + /avatar/delete (the landed avatar store)", () => {
  it("stores an uploaded PNG and clears it again", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi("/setorg/settings/avatar", avatarPost("/setorg/settings/avatar", fixture.ownerCookie, true));
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/setorg/settings");
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: fixture.orgId })).toBe(true);

    const del = await fetchUi("/setorg/settings/avatar/delete", avatarPost("/setorg/settings/avatar/delete", fixture.ownerCookie, false));
    expect(del.status).toBe(303);
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: fixture.orgId })).toBe(false);
  });

  it("redirects silently on an empty upload (upstream's flash-redirect arms)", async () => {
    const fixture = await ensureWave49Fixtures();
    const res = await fetchUi("/setorg/settings/avatar", avatarPost("/setorg/settings/avatar", fixture.ownerCookie, false));
    expect(res.status).toBe(303);
  });
});

describe("POST /{org}/settings/visibility (the landed orgEdit visibility key)", () => {
  it("flips the visibility and answers the no-change arm with a redirect", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi("/setorg/settings/visibility", formPost("/setorg/settings/visibility", { visibility: "limited" }, fixture.ownerCookie));
    expect(post.status).toBe(303);
    expect((await new OrgService(env.DB).getOrgByUsername("setorg"))!.visibility).toBe("limited");
    // Re-flip back (later asserts read a public org) and exercise the
    // unchanged arm + the out-of-enum arm — both upstream redirects.
    for (const body of [{ visibility: "limited" }, { visibility: "bogus" }, { visibility: "public" }]) {
      const res = await fetchUi("/setorg/settings/visibility", formPost("/setorg/settings/visibility", body, fixture.ownerCookie));
      expect(res.status).toBe(303);
    }
    expect((await new OrgService(env.DB).getOrgByUsername("setorg"))!.visibility).toBe("public");
  });
});

// --- the rename + delete danger-zone arms -----------------------------------------

describe("POST /{org}/settings/rename (the landed renameOrg service)", () => {
  it("re-renders with the upstream texts on the confirm and no-change arms", async () => {
    const fixture = await ensureWave49Fixtures();
    const wrong = await fetchUi("/delorg/settings/rename", formPost("/delorg/settings/rename", { org_name: "not-delorg", new_org_name: "delorg2" }, fixture.ownerCookie));
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("The organization name you entered is incorrect.");
    const same = await fetchUi("/delorg/settings/rename", formPost("/delorg/settings/rename", { org_name: "delorg", new_org_name: "delorg" }, fixture.ownerCookie));
    expect(same.status).toBe(200);
    expect(await same.text()).toContain("Organization name is not changed.");
  });

  it("renames and 303s onto the new name's settings page", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi("/delorg/settings/rename", formPost("/delorg/settings/rename", { org_name: "delorg", new_org_name: "delorg2" }, fixture.ownerCookie));
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/delorg2/settings");
    expect(await new OrgService(env.DB).getOrgByUsername("delorg2")).not.toBeNull();
    // The old name rides the redirect row (the RenameUser port).
    const old = await fetchUi("/delorg/settings", withCookie(fixture.ownerCookie));
    expect(old.status).toBe(307);
    expect(old.headers.get("location")).toBe("/delorg2/settings");
  });

  it("answers a collision with the upstream text (the shared-namespace guard)", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi("/delorg2/settings/rename", formPost("/delorg2/settings/rename", { org_name: "delorg2", new_org_name: "setorg" }, fixture.ownerCookie));
    expect(post.status).toBe(200);
    // The banner text HTML-escapes the quoted name in the serialized DOM.
    expect(await post.text()).toContain("The organization name &quot;setorg&quot; has already been taken.");
  });
});

describe("POST /{org}/settings/delete (the landed orgDelete cascade)", () => {
  it("refuses a wrong confirmation and an org that still owns repositories", async () => {
    const fixture = await ensureWave49Fixtures();
    const wrong = await fetchUi("/setorg/settings/delete", formPost("/setorg/settings/delete", { org_name: "not-setorg" }, fixture.ownerCookie));
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("The organization name you entered is incorrect.");
    const owns = await fetchUi("/setorg/settings/delete", formPost("/setorg/settings/delete", { org_name: "setorg" }, fixture.ownerCookie));
    expect(owns.status).toBe(200);
    expect(await owns.text()).toContain("This organization still owns one or more repositories.");
    expect(await new OrgService(env.DB).getOrgByUsername("setorg")).not.toBeNull();
  });

  it("deletes the emptied org and lands on the site root", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi("/delorg2/settings/delete", formPost("/delorg2/settings/delete", { org_name: "delorg2" }, fixture.ownerCookie));
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/");
    expect(await new OrgService(env.DB).getOrgByUsername("delorg2")).toBeNull();
  });
});

// --- the team edit form ------------------------------------------------------------

describe("GET+POST /{org}/teams/{id}/edit (the landed orgEditTeam arm)", () => {
  it("renders the edit form with the stored values for the owner", async () => {
    const fixture = await ensureWave49Fixtures();
    const res = await fetchUi(`/setorg/teams/${fixture.devTeamId}/edit`, withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization new team");
    expect(html).toContain('action="/setorg/teams/');
    expect(html).toContain('value="Dev Team"');
    expect(html).toContain("Ships the settings.");
    expect(html).toContain('value="write" checked');
    // The delete control rides its own form onto the delete route.
    expect(html).toContain('action="/setorg/teams/');
    expect(html).toContain("Delete Team");
  });

  it("renders the stored unit rows of a per-unit team", async () => {
    const fixture = await ensureWave49Fixtures();
    const res = await fetchUi(`/setorg/teams/${fixture.unitTeamId}/edit`, withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="units_present"');
    expect(html).toContain('name="unit_repo.code"');
    expect(html).not.toContain('name="permission" value="read" checked');
  });

  it("carries the org gate (anonymous 303, member 404, unknown/foreign id 404)", async () => {
    const fixture = await ensureWave49Fixtures();
    const anon = await fetchUi(`/setorg/teams/${fixture.devTeamId}/edit`);
    expect(anon.status).toBe(303);
    const member = await fetchUi(`/setorg/teams/${fixture.devTeamId}/edit`, withCookie(fixture.memberCookie));
    expect(member.status).toBe(404);
    const unknown = await fetchUi("/setorg/teams/999999/edit", withCookie(fixture.ownerCookie));
    expect(unknown.status).toBe(404);
  });

  it("applies the form fields and 303s onto the detail slice", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi(
      `/setorg/teams/${fixture.devTeamId}/edit`,
      formPost(`/setorg/teams/${fixture.devTeamId}/edit`, {
        team_name: "Dev Team Renamed",
        description: "Renamed by wave 49.",
        visibility: "public",
        permission: "admin",
        can_create_org_repo: "on",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/setorg/teams/${fixture.devTeamId}`);
    const team = await teamById(fixture.devTeamId);
    expect(team.name).toBe("Dev Team Renamed");
    expect(team.description).toBe("Renamed by wave 49.");
    expect(team.visibility).toBe("public");
    expect(team.authorize).toBe("admin");
    expect(team.canCreateOrgRepo).toBe(true);
  });

  it("re-renders on the required-name and duplicate-name arms", async () => {
    const fixture = await ensureWave49Fixtures();
    const empty = await fetchUi(
      `/setorg/teams/${fixture.devTeamId}/edit`,
      formPost(`/setorg/teams/${fixture.devTeamId}/edit`, { team_name: "  ", description: "x" }, fixture.ownerCookie),
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("Team name is required.");
    const dup = await fetchUi(
      `/setorg/teams/${fixture.devTeamId}/edit`,
      formPost(`/setorg/teams/${fixture.devTeamId}/edit`, { team_name: "Unit Team" }, fixture.ownerCookie),
    );
    expect(dup.status).toBe(200);
    expect(await dup.text()).toContain("The team name is already taken.");
  });

  it("updates a units team's per-unit map through the units_present post", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi(
      `/setorg/teams/${fixture.unitTeamId}/edit`,
      formPost(`/setorg/teams/${fixture.unitTeamId}/edit`, {
        team_name: "Unit Team",
        description: "",
        visibility: "private",
        units_present: "1",
        "unit_repo.code": "write",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    const team = await teamById(fixture.unitTeamId);
    expect(team.authorize).toBe("none");
    expect(JSON.parse(team.unitsMap ?? "{}")).toEqual({ "repo.code": "write" });
  });

  it("converts a units team to a blanket mode when a permission radio posts", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi(
      `/setorg/teams/${fixture.unitTeamId}/edit`,
      formPost(`/setorg/teams/${fixture.unitTeamId}/edit`, {
        team_name: "Unit Team",
        visibility: "private",
        permission: "read",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    const team = await teamById(fixture.unitTeamId);
    expect(team.authorize).toBe("read");
    expect(team.unitsMap).toBeNull();
  });
});

describe("POST /{org}/teams/{id}/delete (the landed orgDeleteTeam cascade)", () => {
  it("405s the GET shape and deletes the team for the owner", async () => {
    const fixture = await ensureWave49Fixtures();
    const get = await fetchUi(`/setorg/teams/${fixture.devTeamId}/delete`, withCookie(fixture.ownerCookie));
    expect(get.status).toBe(405);
    const post = await fetchUi(`/setorg/teams/${fixture.devTeamId}/delete`, formPost(`/setorg/teams/${fixture.devTeamId}/delete`, {}, fixture.ownerCookie));
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/setorg/teams");
    expect(await new TeamsService(env.DB).getTeamById(fixture.devTeamId)).toBeNull();
  });

  it("refuses the last-owner team with a redirect back onto the edit form", async () => {
    const fixture = await ensureWave49Fixtures();
    const post = await fetchUi(`/ownerlock/teams/${fixture.lockTeamId}/delete`, formPost(`/ownerlock/teams/${fixture.lockTeamId}/delete`, {}, fixture.ownerCookie));
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/ownerlock/teams/${fixture.lockTeamId}/edit`);
    expect(await new TeamsService(env.DB).getTeamById(fixture.lockTeamId)).not.toBeNull();
    // The owner's membership survived (the whole upstream tx rolls back).
    expect(
      await drizzle(env.DB)
        .select()
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, fixture.lockOrgId), eq(orgMembers.role, "owner")))
        .all(),
    ).toHaveLength(1);
  });
});

// --- the entry-link hunk + the 405 tails -------------------------------------------

describe("the wave-49 surfaces on the landed pages", () => {
  it("renders the team detail sidebar's Settings button (the entry link)", async () => {
    const fixture = await ensureWave49Fixtures();
    const res = await fetchUi(`/setorg/teams/${fixture.unitTeamId}`, withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/setorg/teams/${fixture.unitTeamId}/edit"`);
  });

  it("answers GET on every POST-only settings tail with chi's 405", async () => {
    const fixture = await ensureWave49Fixtures();
    for (const tail of ["avatar", "avatar/delete", "rename", "delete", "visibility"]) {
      const res = await fetchUi(`/setorg/settings/${tail}`, withCookie(fixture.ownerCookie));
      expect(res.status).toBe(405);
    }
  });
});
