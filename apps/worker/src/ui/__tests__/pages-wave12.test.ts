/**
 * Pages wave 12 route tests (SPEC-0008 U3 extension): the org teams family —
 * the teams list (`/{org}/teams`), the id-keyed detail slice
 * (`/{org}/teams/{id}`, the members + repo-access lists), and the owner's
 * create-team form (`/{org}/teams/new`) — plus the user settings profile
 * page (`/user/settings`), over the landed service arms (pages/org-teams.tsx
 * + pages/user-settings.tsx, whose headers cite the landed modules line by
 * line).
 *
 * Same harness posture as pages-wave2..11: the router is driven directly
 * with the synthetic ASSETS manifest and D1-only fixtures (the org teams
 * pages never read engine content, so no receive-pack is involved) seeded
 * through the landed services with fixed values, identities riding minted
 * session cookies.
 *
 * Gate posture under test: the teams family answers the landed
 * `requireOrgOwnership` collapsed to the settings pages' shape — anonymous
 * 303s onto the login round-trip, a signed-in non-owner (site-wide or
 * org-wide) 404-shells (upstream answers NotFound for every non-member,
 * web.go:980-1001's OrgAssignment); the renamed-org 307 rides the shared
 * resolveOrgForRequest seam. The user settings page is the signed-in self
 * surface — anonymous 303s, every signed-in viewer manages exactly their own
 * row, and the POST re-plays the landed PATCH route's two service halves
 * (verified through the D1 rows and the re-render).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { userSettings, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { TeamsService } from "../../api/routes/org-teams";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const formPost = (path: string, body: Record<string, string>, cookie?: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(body).toString(),
});

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

// --- fixtures -----------------------------------------------------------------

interface Wave12Fixture {
  morganCookie: string; // teamorg's owner
  memberCookie: string; // a plain teamorg member (non-owner)
  palCookie: string; // an unrelated signed-in viewer
  adminCookie: string; // wave12boss — site admin
  orgId: number;
  developersTeamId: number;
  readersTeamId: number;
  outsidersTeamId: number; // otherteamorg's team (the foreign-id arm)
}

let wave12Fixture: Wave12Fixture | null = null;

async function ensureWave12Fixtures(): Promise<Wave12Fixture> {
  if (wave12Fixture !== null) return wave12Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);
  const repoService = new RepoService(env.DB);

  for (const extra of [
    { username: "wave12morgan", isAdmin: false },
    { username: "wave12member", isAdmin: false },
    { username: "wave12pal", isAdmin: false },
    { username: "wave12boss", isAdmin: true },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username, isAdmin: extra.isAdmin });
    }
  }
  const morgan = (await db.select().from(users).where(eq(users.usernameLower, "wave12morgan")).get())!;
  const member = (await db.select().from(users).where(eq(users.usernameLower, "wave12member")).get())!;

  // The owner's org with two repos (one public, one private — the team
  // repo-access list spans both under the owner gate).
  let org = await orgs.getOrgByUsername("teamorg");
  if (org === null) {
    org = await orgs.createOrg({ name: "teamorg", ownerId: morgan.id, visibility: "public", now: t(0) });
    await repoService.create({ owner: { id: org.id, usernameLower: "teamorg" }, name: "open-repo", isPrivate: false, status: "ready" });
    await repoService.create({ owner: { id: org.id, usernameLower: "teamorg" }, name: "secret-repo", isPrivate: true, status: "ready" });
    // The plain member (non-owner — the requireOrgOwnership refusal arm).
    await orgs.addMember(org.id, member.id, { now: t(1) });
  }
  org = (await orgs.getOrgByUsername("teamorg"))!;

  // A second org with its own team (the foreign-id 404 arm), and the rename
  // pair (the shared 307 seam).
  if ((await orgs.getOrgByUsername("otherteamorg")) === null) {
    await orgs.createOrg({ name: "otherteamorg", ownerId: morgan.id, visibility: "public", now: t(0) });
  }
  const other = (await orgs.getOrgByUsername("otherteamorg"))!;
  if ((await orgs.getOrgByUsername("teamnew")) === null) {
    const old = await orgs.createOrg({ name: "teamold", ownerId: morgan.id, visibility: "public", now: t(0) });
    await orgs.renameOrg(old.id, "teamnew", { now: t(1) });
  }

  // The teams through the landed service (the ids, maintained counters and
  // the includes-all fan-out are exactly the service's).
  const service = new TeamsService(env.DB);
  let developers = await service.getTeamByName(org.id, "Developers");
  if (developers === null) {
    developers = await service.createTeam(org, { name: "Developers", permission: "write", description: "Ships the waves." });
    await service.addTeamMember(developers, morgan.id);
    await service.addTeamMember(developers, member.id);
    for (const slug of ["open-repo", "secret-repo"]) {
      const repo = await repoService.getBySlug("teamorg", slug);
      if (repo === null) throw new Error(`teamorg/${slug} repo row missing`);
      await service.addTeamRepo(developers, repo.id);
    }
  }
  let readers = await service.getTeamByName(org.id, "Readers");
  if (readers === null) {
    readers = await service.createTeam(org, { name: "Readers", permission: "read", includes_all_repositories: true });
  }
  let outsiders = await service.getTeamByName(other.id, "Outsiders");
  if (outsiders === null) {
    outsiders = await service.createTeam(other, { name: "Outsiders", permission: "read" });
  }

  wave12Fixture = {
    morganCookie: await mintSession(env.DB, morgan.id),
    memberCookie: await mintSession(env.DB, member.id),
    palCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave12pal")).get())!.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave12boss")).get())!.id),
    orgId: org.id,
    developersTeamId: developers.id,
    readersTeamId: readers.id,
    outsidersTeamId: outsiders.id,
  };
  return wave12Fixture;
}

beforeAll(async () => {
  await ensureWave12Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-12 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the org teams shapes", () => {
    expect(parseUiRoute("/acme/teams")).toEqual({ family: "org-teams", owner: "acme" });
    expect(parseUiRoute("/acme/teams/new")).toEqual({ family: "org-team-new", owner: "acme" });
    expect(parseUiRoute("/acme/teams/42")).toEqual({ family: "org-team-detail", owner: "acme", id: 42 });
    // int64 parity (org-teams.ts intPathParam): "007" parses as 7.
    expect(parseUiRoute("/acme/teams/007")).toEqual({ family: "org-team-detail", owner: "acme", id: 7 });
    expect(handlesUiRoute("/acme/teams")).toBe(true);
    // The trailing-slash form classifies to the same shape (the dispatcher's
    // middleware 301s it to the canonical URL).
    expect(parseUiRoute("/acme/teams/")).toEqual({ family: "org-teams", owner: "acme" });
  });

  it("leaves the deeper tails and junk ids with the engine", () => {
    expect(parseUiRoute("/acme/teams/42/repositories")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/edit")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/action/join")).toBeNull();
    expect(parseUiRoute("/acme/teams/not-a-number")).toBeNull();
    expect(parseUiRoute("/acme/teams/new/more")).toBeNull();
  });

  it("claims the user settings literal before the repo parse", () => {
    expect(parseUiRoute("/user/settings")).toEqual({ family: "user-settings" });
    expect(handlesUiRoute("/user/settings")).toBe(true);
    expect(parseUiRoute("/user/settings/account")).toBeNull();
    expect(parseUiRoute("/user/settings/avatar")).toBeNull();
  });

  it("shadows a repository named 'teams' exactly like upstream's route order", () => {
    // web.go:993 (org teams group) registers ahead of :1292's
    // /{username}/{reponame} — the shape belongs to the teams family; a
    // user owner 404-shells at resolve time (the resolve gate below).
    expect(parseUiRoute("/alice/teams")).toEqual({ family: "org-teams", owner: "alice" });
  });
});

// --- the teams list gate --------------------------------------------------------

describe("GET /{org}/teams (the requireOrgOwnership posture)", () => {
  it("303s an anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/teamorg/teams");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fteamorg%2Fteams");
  });

  it("404-shells a signed-in non-member and a plain member (non-owner)", async () => {
    const fixture = await ensureWave12Fixtures();
    const pal = await fetchUi("/teamorg/teams", withCookie(fixture.palCookie));
    expect(pal.status).toBe(404);
    // Upstream's teams page admits org members (web.go:980-1001) — the wave
    // brief pins the landed requireOrgOwnership posture: a member without
    // the owner role 404-shells exactly like a stranger.
    const member = await fetchUi("/teamorg/teams", withCookie(fixture.memberCookie));
    expect(member.status).toBe(404);
  });

  it("answers the owner and a site admin with the list", async () => {
    const fixture = await ensureWave12Fixtures();
    for (const cookie of [fixture.morganCookie, fixture.adminCookie]) {
      const res = await fetchUi("/teamorg/teams", withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("page-content organization teams");
      // The row content: name link onto the id-keyed detail, the
      // permission badge, the maintained counters.
      expect(html).toContain(`/teamorg/teams/${fixture.developersTeamId}`);
      expect(html).toContain("<strong>Developers</strong>");
      expect(html).toContain("Ships the waves.");
      // Permission badge (the brief's addition) + the visibility badge.
      expect(html).toContain("Write</span>");
      expect(html).toContain("Private</span>");
      // Member strip + counts.
      expect(html).toContain('href="/wave12morgan"');
      expect(html).toContain("2 members");
      expect(html).toContain("2 repositories");
      // The New Team button anchors the live form.
      expect(html).toContain('href="/teamorg/teams/new"');
    }
  });

  it("filters the list by the q keyword (the landed listTeams read)", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi("/teamorg/teams?q=devel", withCookie(fixture.morganCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>Developers</strong>");
    expect(html).not.toContain("<strong>Readers</strong>");
  });

  it("404-shells a user owner (never an org) and answers a renamed org with the 307", async () => {
    const fixture = await ensureWave12Fixtures();
    // A USER namespace: the org resolution's type gate misses → the shell.
    const user = await fetchUi("/wave12pal/teams", withCookie(fixture.palCookie));
    expect(user.status).toBe(404);
    // A renamed org: the shared resolveOrgForRequest seam 307s (query
    // preserved).
    const renamed = await fetchUi("/teamold/teams?q=x", withCookie(fixture.morganCookie));
    expect(renamed.status).toBe(307);
    expect(renamed.headers.get("location")).toBe("/teamnew/teams?q=x");
  });
});

// --- the team detail slice ------------------------------------------------------

describe("GET /{org}/teams/{id} (the detail slice)", () => {
  it("renders the sidebar and both lists for the owner", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi(`/teamorg/teams/${fixture.developersTeamId}`, withCookie(fixture.morganCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization teams");
    // The sidebar: name + badges, description, access + permission sections.
    expect(html).toContain("<strong>Developers</strong>");
    expect(html).toContain("Specific repositories");
    expect(html).toContain("This team grants <strong>Write</strong> access");
    // The members list (both principals) and the repo-access list (public
    // + private — the owner gate reads both).
    expect(html).toContain('href="/wave12morgan"');
    expect(html).toContain('href="/wave12member"');
    expect(html).toContain(">teamorg/open-repo</a>");
    expect(html).toContain(">teamorg/secret-repo</a>");
  });

  it("renders the includes-all arm of the access section", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi(`/teamorg/teams/${fixture.readersTeamId}`, withCookie(fixture.morganCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>Readers</strong>");
    expect(html).toContain("All repositories");
    // The includes-all fan-out covered the org's repos at create — the
    // repo-access list serves both.
    expect(html).toContain(">teamorg/open-repo</a>");
    expect(html).toContain(">teamorg/secret-repo</a>");
    // The plain read permission renders the access-mode text (no units).
    expect(html).toContain("<h3>Permission</h3><p>Read</p>");
  });

  it("404-shells an unknown id and a foreign org's team", async () => {
    const fixture = await ensureWave12Fixtures();
    const unknown = await fetchUi("/teamorg/teams/999999", withCookie(fixture.morganCookie));
    expect(unknown.status).toBe(404);
    // The id keys globally — another org's team never leaks through it.
    const foreign = await fetchUi(`/teamorg/teams/${fixture.outsidersTeamId}`, withCookie(fixture.morganCookie));
    expect(foreign.status).toBe(404);
  });

  it("carries the list gate: anonymous 303, non-owner 404", async () => {
    const fixture = await ensureWave12Fixtures();
    const anon = await fetchUi(`/teamorg/teams/${fixture.developersTeamId}`);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");
    const member = await fetchUi(`/teamorg/teams/${fixture.developersTeamId}`, withCookie(fixture.memberCookie));
    expect(member.status).toBe(404);
  });
});

// --- the create-team form + POST -------------------------------------------------

describe("GET+POST /{org}/teams/new (the owner's create form)", () => {
  it("renders the form for the owner and gates it like the list", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi("/teamorg/teams/new", withCookie(fixture.morganCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization new team");
    expect(html).toContain('id="team_name" name="team_name"');
    expect(html).toContain('id="permission" name="permission"');
    expect(html).toContain('<option value="read" selected="">');
    expect(html).toContain('action="/teamorg/teams/new" method="post"');

    const anon = await fetchUi("/teamorg/teams/new");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");
    const member = await fetchUi("/teamorg/teams/new", withCookie(fixture.memberCookie));
    expect(member.status).toBe(404);
  });

  it("creates through the landed arm and 303s onto the created detail slice", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "Ship Crew", permission: "admin" }, fixture.morganCookie),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/teamorg/teams/")).toBe(true);
    const teamId = Number.parseInt(location.split("/").pop() ?? "0", 10);
    const row = await new TeamsService(env.DB).getTeamById(teamId);
    expect(row?.name).toBe("Ship Crew");
    expect(row?.authorize).toBe("admin");
    expect(row?.visibility).toBe("private"); // the service default (no input)
    // The created detail slice renders the new team.
    const detail = await fetchUi(location, withCookie(fixture.morganCookie));
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("<strong>Ship Crew</strong>");
  });

  it("re-renders the typed 422s with the API messages and the kept submission", async () => {
    const fixture = await ensureWave12Fixtures();
    // The duplicate (case-insensitive — the UNIQUE arbiter).
    const dup = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "developers", permission: "read" }, fixture.morganCookie),
    );
    expect(dup.status).toBe(200);
    const dupHtml = await dup.text();
    expect(dupHtml).toContain("team already exists");
    expect(dupHtml).toContain('value="developers"');

    // The empty name (the typed TeamNameEmptyError).
    const empty = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "", permission: "read" }, fixture.morganCookie),
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("empty team name");

    // The `owners` bridge: the role row IS the Owners team — the duplicate
    // 422 (createTeam's §3.3 arm).
    const owners = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "owners", permission: "admin" }, fixture.morganCookie),
    );
    expect(owners.status).toBe(200);
    expect(await owners.text()).toContain("team already exists");
  });

  it("refuses the write for the anonymous and the unprivileged, and cross-origin posts", async () => {
    const fixture = await ensureWave12Fixtures();
    const anon = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "Nope", permission: "read" }),
    );
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");

    const member = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "Nope", permission: "read" }, fixture.memberCookie),
    );
    expect(member.status).toBe(404);

    const crossOrigin = await fetchUi(
      "/teamorg/teams/new",
      formPost("/teamorg/teams/new", { team_name: "Nope", permission: "read" }, fixture.morganCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

// --- the user settings page ------------------------------------------------------

describe("GET+POST /user/settings (the signed-in profile form)", () => {
  it("303s an anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/user/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fuser%2Fsettings");
  });

  it("renders the profile form with the read-only arms for the signed-in viewer", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi("/user/settings", withCookie(fixture.palCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content user settings profile");
    expect(html).toContain('class="header item"');
    // The username renders disabled (the arm owns no name key — the input
    // is never submitted).
    expect(html).toContain('id="username" name="name" value="wave12pal"');
    expect(html).toContain('value="wave12pal" data-name="wave12pal" required="" disabled=""');
    // The email renders as the read-only <p> (upstream's own shape — the
    // arm owns no email key).
    expect(html).toContain('id="signed-user-email"');
    // The privacy checkboxes default unchecked (the store's creation
    // defaults).
    expect(html).toContain('id="keep_email_private" name="keep_email_private" type="checkbox"');
    expect(html).not.toContain('id="keep_email_private" name="keep_email_private" type="checkbox" checked');
    // NO credential surfaces (the module header): no password/token fields,
    // no Account/Security/Applications navbar items.
    expect(html.toLowerCase()).not.toContain('type="password"');
    expect(html).not.toContain("Security");
    expect(html).not.toContain("Applications");
  });

  it("applies the PATCH route's two service halves and 303s back", async () => {
    const fixture = await ensureWave12Fixtures();
    const db = drizzle(env.DB);
    const pal = (await db.select().from(users).where(eq(users.usernameLower, "wave12pal")).get())!;
    const res = await fetchUi(
      "/user/settings",
      formPost(
        "/user/settings",
        {
          full_name: "Pal I. Twelve",
          description: "Watches the waves.",
          website: "https://pal.example",
          location: "The pier",
          keep_email_private: "on",
        },
        fixture.palCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings");

    // The users row (saveUserProfileColumns) — the `full_name` key lands
    // on users.display_name (services/user-settings.ts's mapping, the
    // User.full_name projection's home column)…
    const row = (await db.select().from(users).where(eq(users.id, pal.id)).get())!;
    expect(row.displayName).toBe("Pal I. Twelve");
    expect(row.description).toBe("Watches the waves.");
    expect(row.website).toBe("https://pal.example");
    expect(row.location).toBe("The pier");
    // …and the side store (saveUserSettings): the carried flag flipped, the
    // un-carried one kept its default.
    const stored = await db.select().from(userSettings).where(eq(userSettings.userId, pal.id)).get();
    expect(stored?.hideEmail).toBe(true);
    expect(stored?.hideActivity).toBe(false);

    // The re-render shows the stored values (the checkbox checked now).
    const rerender = await fetchUi("/user/settings", withCookie(fixture.palCookie));
    const html = await rerender.text();
    expect(html).toContain('value="Pal I. Twelve"');
    expect(html).toContain('id="keep_email_private" name="keep_email_private" type="checkbox" checked=""');
    // The visibility line stays read-only text.
    expect(html).toContain("Public");
  });

  it("clears a profile field on an empty submission and unchecks a dropped flag", async () => {
    const fixture = await ensureWave12Fixtures();
    const db = drizzle(env.DB);
    const pal = (await db.select().from(users).where(eq(users.usernameLower, "wave12pal")).get())!;
    const res = await fetchUi(
      "/user/settings",
      formPost("/user/settings", { full_name: "", description: "", website: "", location: "" }, fixture.palCookie),
    );
    expect(res.status).toBe(303);
    const row = (await db.select().from(users).where(eq(users.id, pal.id)).get())!;
    expect(row.displayName).toBe(""); // the empty string clears (upstream's empty-pointer semantics)
    const stored = await db.select().from(userSettings).where(eq(userSettings.userId, pal.id)).get();
    expect(stored?.hideEmail).toBe(false); // the absent checkbox unchecks
  });

  it("refuses cross-origin posts", async () => {
    const fixture = await ensureWave12Fixtures();
    const res = await fetchUi(
      "/user/settings",
      formPost("/user/settings", { full_name: "Evil" }, fixture.palCookie, "https://evil.example"),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-12 a11y smoke", () => {
  it("every new page passes the structural rules for its gate-admitted viewer", async () => {
    const fixture = await ensureWave12Fixtures();
    for (const [path, init] of [
      ["/teamorg/teams", withCookie(fixture.morganCookie)],
      [`/teamorg/teams/${fixture.developersTeamId}`, withCookie(fixture.morganCookie)],
      [`/teamorg/teams/${fixture.readersTeamId}`, withCookie(fixture.adminCookie)],
      ["/teamorg/teams/new", withCookie(fixture.morganCookie)],
      ["/user/settings", withCookie(fixture.palCookie)],
    ] as Array<[string, RequestInit]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
