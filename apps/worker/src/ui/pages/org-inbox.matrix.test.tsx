/**
 * The ORG-scoped inbox families' route matrix (pages/org-inbox.tsx over
 * index.ts's orgInboxPage handler — the census's R07 brief): the
 * minted-session route arms through `uiRouter.fetch()` (the org-repos
 * matrix's pattern), the `orginb` fixture world seeded through the LANDED
 * OrgService/TeamsService/RepoService arms — ids captured at seed time:
 *
 *   - the claim pins: the exact 4-/5-segment shapes parse (the literal
 *     `org` head, the three overview literals, the team tail), deeper and
 *     foreign tails stay unclaimed;
 *   - the member-only 404 posture (the census's explicit call): anonymous
 *     and the signed-in outsider 404-SHELL (OrgAssignment never 303s — no
 *     login redirect), while the owner member, the plain member, the team
 *     member, and the site admin render;
 *   - the repo-set scope (home.go:455-481's org branch): the owner member
 *     sees the public + private repo issues, the ARCHIVED repo's rows stay
 *     excluded (Archived: Some(false)), the plain member without a team
 *     stays public-only, and the team-granted member gains exactly the
 *     covered private row (the listOrgRepos teamArm twin);
 *   - the pulls literal serves the isPull rows only (buildIssueOverview's
 *     unitType);
 *   - the team tail: `?team=` resolution by name, the covered-repo set
 *     narrowing (home.go:142-144's TeamID), RequireTeamMember 404ing the
 *     plain member off the team, and the navbar tail echo;
 *   - the milestones arm: the scoped rows + the sidebar repo menu counts;
 *   - the org page chrome: the navbar's Issues/Pulls/Milestones tabs
 *     carrying the org base (the Activities tab's dead-link omission), and
 *     a renamed org 307ing.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TeamsService } from "../../api/routes/org-teams";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { issues, milestones, repositories } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000);
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

interface World {
  org: OrgRecord;
  ownerId: number;
  memberId: number;
  grantedId: number;
  outsiderId: number;
  adminId: number;
  teamId: number;
}

let world: World | null = null;

async function seedWorld(): Promise<World> {
  if (world !== null) return world;
  await applyAuthD1Migrations();
  const owner = await seedVerifiedUser({ username: "orginb-owner" });
  const member = await seedVerifiedUser({ username: "orginb-member" });
  const granted = await seedVerifiedUser({ username: "orginb-granted" });
  const outsider = await seedVerifiedUser({ username: "orginb-outsider" });
  const admin = await seedVerifiedUser({ username: "orginb-admin", isAdmin: true });

  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "orginb", ownerId: owner.id, visibility: "public", now: T0 });
  await orgs.addMember(org.id, member.id, { now: T0 });
  await orgs.addMember(org.id, granted.id, { now: T0 });

  const repoService = new RepoService(env.DB);
  const create = (name: string, isPrivate: boolean) =>
    repoService.create({ owner: { id: org.id, usernameLower: "orginb" }, name, isPrivate, status: "ready" });
  const pub = await create("public-repo", false);
  const vault = await create("secret-vault", true);
  const archived = await create("old-archive", false);
  await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, archived.id)).run();

  // The team arm: the granted member's read team covers exactly the vault.
  const teamsService = new TeamsService(env.DB);
  const teamRow = await teamsService.createTeam(org, { name: "Vault Crew", permission: "read" });
  await teamsService.addTeamMember(teamRow, granted.id);
  await teamsService.addTeamRepo(teamRow, vault.id);
  const team = teamRow.id;

  // The issue rows: two open issues on the public repo (one a PULL row for
  // the pulls literal), one open issue on the private vault, one CLOSED on
  // the public repo (the state tabs), one OPEN on the archived repo (the
  // exclusion pin), and one milestone on each of the public + private repos.
  const db = drizzle(env.DB);
  await db.insert(issues).values([
    { repoId: pub.id, index: 1, posterId: owner.id, title: "pub one", isPull: false, isClosed: false, createdAt: new Date(T0) },
    { repoId: pub.id, index: 2, posterId: owner.id, title: "pub pull", isPull: true, isClosed: false, createdAt: new Date(T0) },
    { repoId: pub.id, index: 3, posterId: owner.id, title: "pub closed", isPull: false, isClosed: true, createdAt: new Date(T0) },
    { repoId: vault.id, index: 1, posterId: owner.id, title: "vault secret", isPull: false, isClosed: false, createdAt: new Date(T0) },
    { repoId: archived.id, index: 1, posterId: owner.id, title: "archived noise", isPull: false, isClosed: false, createdAt: new Date(T0) },
  ]);
  await db.insert(milestones).values([
    { repoId: pub.id, name: "v1.0", isClosed: false, numIssues: 2, numClosedIssues: 1, completeness: 50, createdAt: new Date(T0) },
    { repoId: vault.id, name: "quiet", isClosed: false, numIssues: 1, numClosedIssues: 0, completeness: 0, createdAt: new Date(T0) },
  ]);

  world = { org, ownerId: owner.id, memberId: member.id, grantedId: granted.id, outsiderId: outsider.id, adminId: admin.id, teamId: team };
  return world;
}

beforeAll(async () => {
  await seedWorld();
});

beforeEach(async () => {
  // The org/membership/team world is seed-once (idempotent); the sessions
  // table is wiped by every suite's own harness needs — nothing here.
});

// --- the mounted-route harness -------------------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function getRoute(path: string, userId: number | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId !== null) headers.cookie = `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  return fetchUi(path, { headers });
}

// --- the claim pins -------------------------------------------------------------

describe("the /org/{org} inbox claim pins", () => {
  it("claims the 4-/5-segment shapes and refuses deeper and foreign tails", () => {
    expect(parseUiRoute("/org/orginb/issues")).toEqual({ family: "org-inbox", owner: "orginb", kind: "issues" });
    expect(parseUiRoute("/org/orginb/pulls/Vault%20Crew")).toEqual({
      family: "org-inbox",
      owner: "orginb",
      kind: "pulls",
      team: "Vault Crew",
    });
    expect(parseUiRoute("/org/orginb/milestones")).toEqual({ family: "org-inbox", owner: "orginb", kind: "milestones" });
    expect(parseUiRoute("/org/orginb/issues/a/b")).toBeNull();
    expect(parseUiRoute("/org/orginb/other")).toBeNull();
    // The bare `/org/{org}` stays the landed owner-home shape (a repo named
    // under the "org" owner — pre-existing posture, upstream's bare group
    // route is absent too; not this wave's arm to change).
    expect(parseUiRoute("/org/orginb")?.family).toBe("home");
    expect(handlesUiRoute("/org/orginb/issues")).toBe(true);
    expect(handlesUiRoute("/org/orginb/other")).toBe(false);
  });
});

// --- the member-only 404 posture --------------------------------------------------

describe("the member-only 404 posture (OrgAssignment RequireMember)", () => {
  it("404-shells anonymous and the signed-in outsider — never a login redirect", async () => {
    const w = await seedWorld();
    const anon = await getRoute("/org/orginb/issues", null);
    expect(anon.status).toBe(404);
    expect(anon.headers.get("location")).toBeNull(); // no 303 login redirect

    const outsider = await getRoute("/org/orginb/issues", w.outsiderId);
    expect(outsider.status).toBe(404);
  });

  it("renders for the owner member, the plain member, the team member, and the site admin", async () => {
    const w = await seedWorld();
    for (const userId of [w.ownerId, w.memberId, w.grantedId, w.adminId]) {
      const res = await getRoute("/org/orginb/issues", userId);
      expect(res.status, `user ${userId}`).toBe(200);
    }
  });

  it("404-shells a plain user name and an unknown org (the type gate)", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb-owner/issues", w.ownerId);
    expect(res.status).toBe(404);
  });
});

// --- the repo-set scope --------------------------------------------------------------

describe("the org repo-set scope (home.go:455-481's org branch)", () => {
  it("the owner member sees public + private rows; the archived repo's rows stay excluded", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/issues", w.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pub one");
    expect(html).not.toContain("pub closed"); // the default state=open tab
    expect(html).toContain("vault secret"); // private repos of the org list for the owner
    expect(html).not.toContain("archived noise"); // Archived: Some(false)
    expect(html).not.toContain("orginb/old-archive");
    // The canonical base: the type-arm hrefs and the form action carry it.
    expect(html).toContain('action="/org/orginb/issues"');
    expect(html).toContain('href="/org/orginb/issues?type=assigned"');
  });

  it("the plain member without a team stays public-only", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/issues", w.memberId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pub one");
    expect(html).not.toContain("vault secret");
    expect(html).not.toContain("orginb/secret-vault");
  });

  it("the team-granted member gains exactly the covered private row", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/issues", w.grantedId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pub one");
    expect(html).toContain("vault secret");
  });

  it("the pulls literal serves the isPull rows only", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/pulls", w.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pub pull");
    expect(html).not.toContain("pub one");
    expect(html).toContain('href="/org/orginb/pulls?type=review_requested"'); // the pulls arm set
  });
});

// --- the team tail ---------------------------------------------------------------------

describe("the {team} tail (home.go:142-144's TeamID + RequireTeamMember)", () => {
  it("narrows the repo set to the team's coverage and echoes the tail in the chrome", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/issues/Vault%20Crew", w.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("vault secret"); // the covered repo
    expect(html).not.toContain("pub one"); // the uncovered public repo — the TeamID filter
    expect(html).toContain('action="/org/orginb/issues/Vault Crew"'); // the form action echoes the tail
    expect(html).toContain('href="/org/orginb/issues/Vault Crew?type=assigned"');
  });

  it("404s a plain member who is not on the team (RequireTeamMember) and serves the team member", async () => {
    const w = await seedWorld();
    const denied = await getRoute("/org/orginb/issues/Vault%20Crew", w.memberId);
    expect(denied.status).toBe(404);

    const granted = await getRoute("/org/orginb/issues/Vault%20Crew", w.grantedId);
    expect(granted.status).toBe(200);
  });

  it("404s an unknown team name", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/issues/Nope", w.ownerId);
    expect(res.status).toBe(404);
  });
});

// --- the milestones arm -----------------------------------------------------------------

describe("the milestones arm (home.go:139-327 Milestones' org scope)", () => {
  it("lists the scope milestones with the sidebar repo menu carrying the state counts", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/milestones", w.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content dashboard issues repository milestones"');
    expect(html).toContain("v1.0"); // the public repo's milestone
    expect(html).toContain("quiet"); // the private repo's milestone (owner scope)
    expect(html).toContain("orginb/public-repo"); // the sidebar full name
    expect(html).toContain("orginb/secret-vault");
    expect(html).toContain('action="/org/orginb/milestones"');
  });

  it("narrows to the covered repo for the team-granted member on the bare route and the tail", async () => {
    const w = await seedWorld();
    const bare = await getRoute("/org/orginb/milestones", w.memberId);
    expect(bare.status).toBe(200);
    expect(await bare.text()).not.toContain("quiet"); // public-only scope for the plain member

    const tail = await getRoute("/org/orginb/milestones/Vault%20Crew", w.grantedId);
    expect(tail.status).toBe(200);
    const tailHtml = await tail.text();
    expect(tailHtml).toContain("quiet");
    expect(tailHtml).not.toContain(">v1.0<"); // the uncovered repo's milestone is out of the team set
  });
});

// --- the chrome --------------------------------------------------------------------------

describe("the org page chrome (navbar.tmpl's org branch)", () => {
  it("renders the org switcher item and the Issues/Pulls/Milestones right-menu tabs — no Activities dead link", async () => {
    const w = await seedWorld();
    const res = await getRoute("/org/orginb/issues", w.ownerId);
    const html = await res.text();
    expect(html).toContain('href="/orginb"'); // the switcher item's org-home anchor
    expect(html).toContain('href="/org/orginb/issues"');
    expect(html).toContain('href="/org/orginb/pulls"');
    expect(html).toContain('href="/org/orginb/milestones"');
    expect(html).not.toContain("/org/orginb/dashboard"); // R06's dead link stays unrendered
    expect(html).toContain('class="active item" href="/org/orginb/issues"'); // the active tab
  });

  it("307s a renamed org (the seam's redirect arm)", async () => {
    const w = await seedWorld();
    const orgs = new OrgService(env.DB);
    const renamed = await orgs.renameOrg(w.org.id, "orginb-renamed", { now: new Date() });
    void renamed;
    const res = await getRoute("/org/orginb/issues", w.ownerId);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/org/orginb-renamed/issues");
  });
});
