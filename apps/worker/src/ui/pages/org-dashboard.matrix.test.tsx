/**
 * The ORG DASHBOARD's route-level matrix (the census R06 row — pages/
 * org-dashboard.tsx over index.ts's orgDashboardPage, mounted on the
 * /org/:owner/dashboard[/:team] registrations): the MINTED-SESSION route
 * arms driven through `uiRouter.fetch()` on the real production path
 * (parse → resolveUiSession → the member-only prologue → load → render —
 * the org-teams matrix's harness pattern), one fresh org world per test
 * behind per-test table wipes. The arms:
 *
 *   - the claim pins: the four/five-segment literal shapes, the junk
 *     neighbors (/org/{org}/other, deeper tails, the /-/heatmap tail — R03
 *     unclaimed), malformed percent-encoding, and handlesUiRoute;
 *   - the MEMBER-ONLY gate (upstream web.go:982-985's OrgAssignment
 *     {RequireMember: true} posture the census's Open Issues #9 pins):
 *     anonymous 404-SHELLS (upstream NotFound — NO login redirect, the
 *     group is not reqSignIn'd), a signed-in outsider 404-shells, the
 *     plain member/owner/site admin render; the renamed-org 307 through
 *     the shared resolveOrgForRequest seam; the user-namespace segment
 *     404-shells (the §4.11 type gate);
 *   - the page shape: `dashboard feeds`, the title pair, the navbar's
 *     switcher/team-filter/right-menu arms, the feeds rows over the landed
 *     activity rendering, the guide arm on an empty feed (upstream's
 *     Paginator.TotalPages=0 posture), the sidebar's doer-accessible repo
 *     rows + the widget header's count and `+` link;
 *   - the {team} tail: RequireTeamMember (owner/site-admin pass, a member
 *     ON the team passes, a member OFF it 404-shells, an unknown name
 *     404-shells), the team dropdown's includes-all exclusion, and the
 *     repo-set filtering (an extra-repo action outside the team's coverage
 *     shows on the all-teams feed and hides on the team feed);
 *   - the ?date window (FeedDateCond) and the Older/Newer pager.
 *
 * The fixture org is `dashorg` (nadia owner, milo plain member on the
 * Alpha Crew team, vera outsider, admindx site admin; `otherorg` for the
 * switcher; `freshorg` for the guide arm), seeded through the LANDED
 * OrgService/TeamsService/RepoService arms; feed rows ride the landed
 * `recordAction` fan-out (the org-receiver rows the org feed reads). Ids
 * are captured at seed time — never hardcoded.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { ActionType, recordAction } from "../../api/services/activity-feeds";
import { TeamsService } from "../../api/routes/org-teams";
import { userRedirects } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z — a ?date-pinnable instant
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** Tables the fixtures touch (children first — the blocked-users harness's
 *  cleanup-list convention; "sessions" explicit because the route matrix
 *  mints session rows per request; the feed store is `action` — singular —
 *  schema.ts's sqliteTable name). */
const FIXTURE_TABLES = [
  "action",
  "team_repo_access",
  "team_members",
  "teams",
  "repo_settings",
  "repo_counters",
  "repositories",
  "org_members",
  "user_redirects",
  "sessions",
  "users",
];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** The route world's REAL rows: the dashorg org (nadia owner, milo plain
 *  member), vera the outsider, admindx the site admin, the otherorg
 *  membership for the switcher, three repos (open public, secret private —
 *  both covered by Alpha Crew — and extra public, covered only by the
 *  includes-all team), Alpha Crew (write, specific repos, nadia+milo),
 *  All Repos (read, includes-all, nadia) and Solo Crew (read, nadia only —
 *  the team-gate's off-team carrier), and four feed rows through the landed
 *  recordAction fan-out. Ids are captured at seed time — never hardcoded. */
interface DashWorld {
  org: OrgRecord;
  ownerId: number; // nadia
  memberId: number; // milo (Alpha Crew member, no ownership)
  outsiderId: number; // vera
  adminId: number; // admindx (site admin)
  openRepoId: string;
  secretRepoId: string;
  extraRepoId: string;
  alphaTeamId: number;
  allTeamId: number;
  soloTeamId: number;
}

async function seedDashWorld(): Promise<DashWorld> {
  const owner = await seedVerifiedUser({ username: "nadia" });
  const member = await seedVerifiedUser({ username: "milo" });
  const outsider = await seedVerifiedUser({ username: "vera" });
  const admin = await seedVerifiedUser({ username: "admindx", isAdmin: true });

  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "dashorg", ownerId: owner.id, visibility: "public", now: T0 });
  await orgs.addMember(org.id, member.id, { now: T0 });
  const other = await orgs.createOrg({ name: "otherorg", ownerId: owner.id, visibility: "public", now: T0 });
  await orgs.addMember(other.id, member.id, { now: T0 });

  const repoService = new RepoService(env.DB);
  const ownerRef = { id: org.id, usernameLower: "dashorg" };
  const open = await repoService.create({ owner: ownerRef, name: "open-repo", isPrivate: false, status: "ready" });
  const secret = await repoService.create({ owner: ownerRef, name: "secret-repo", isPrivate: true, status: "ready" });
  const extra = await repoService.create({ owner: ownerRef, name: "extra-repo", isPrivate: false, status: "ready" });

  const service = new TeamsService(env.DB);
  const alpha = await service.createTeam(org, { name: "Alpha Crew", permission: "write", description: "Ships it." });
  await service.addTeamMember(alpha, owner.id);
  await service.addTeamMember(alpha, member.id);
  await service.addTeamRepo(alpha, open.id);
  await service.addTeamRepo(alpha, secret.id);
  const all = await service.createTeam(org, {
    name: "All Repos",
    permission: "read",
    includes_all_repositories: true,
  });
  await service.addTeamMember(all, owner.id);
  const solo = await service.createTeam(org, { name: "Solo Crew", permission: "read" });
  await service.addTeamMember(solo, owner.id);

  // Four org-receiver feed rows (the actor + org fan-out — the org feed
  // reads user_id = org.id): three issues in open-repo, one in extra-repo
  // (outside Alpha Crew's coverage — the team-feed filter's probe), all at
  // T0 so the ?date window pins.
  await recordAction(env.DB, {
    actUserId: member.id,
    repoId: open.id,
    opType: ActionType.CreateIssue,
    isPrivate: false,
    content: "7|Pinned the matrix",
    createdAt: T0,
  });
  await recordAction(env.DB, {
    actUserId: owner.id,
    repoId: open.id,
    opType: ActionType.CreateRepo,
    isPrivate: false,
    createdAt: T0,
  });
  await recordAction(env.DB, {
    actUserId: member.id,
    repoId: secret.id,
    opType: ActionType.CreateIssue,
    isPrivate: true,
    content: "3|Secret plans",
    createdAt: T0,
  });
  await recordAction(env.DB, {
    actUserId: owner.id,
    repoId: extra.id,
    opType: ActionType.CreateRepo,
    isPrivate: false,
    createdAt: T0,
  });

  return {
    org,
    ownerId: owner.id,
    memberId: member.id,
    outsiderId: outsider.id,
    adminId: admin.id,
    openRepoId: open.id,
    secretRepoId: secret.id,
    extraRepoId: extra.id,
    alphaTeamId: alpha.id,
    allTeamId: all.id,
    soloTeamId: solo.id,
  };
}

// --- the mounted-route harness (the org-teams matrix pattern) ----------------

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

async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A GET through the mount (`userId: null` is the anonymous arm). */
async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

/** The 404 fidelity every gate miss shares: the shell answers, never the
 *  dashboard's content. */
async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain("status-page-error"); // the 404 shell
  expect(html).not.toContain("page-content dashboard feeds"); // never the dashboard
}

// --- the claim pins (parseUiRoute / handlesUiRoute) ---------------------------

describe("org-dashboard claim pins", () => {
  it("claims the four/five-segment literal shapes and leaves the neighbors with the engine", () => {
    expect(parseUiRoute("/org/dashorg/dashboard")).toEqual({ family: "org-dashboard", owner: "dashorg" });
    expect(parseUiRoute("/org/dashorg/dashboard/Alpha%20Crew")).toEqual({
      family: "org-dashboard",
      owner: "dashorg",
      team: "Alpha Crew",
    });
    expect(parseUiRoute("/org/dashorg/dashboard/squad")).toEqual({
      family: "org-dashboard",
      owner: "dashorg",
      team: "squad",
    });
    expect(handlesUiRoute("/org/dashorg/dashboard")).toBe(true);
    expect(handlesUiRoute("/org/dashorg/dashboard/squad")).toBe(true);
    // The junk neighbors stay engine-owned: a different literal third
    // segment, deeper tails, and the /-/heatmap tail (R03 — unclaimed,
    // the engine's 404 exactly like upstream's unregistered route).
    expect(parseUiRoute("/org/dashorg/other")).toBeNull();
    expect(parseUiRoute("/org/dashorg/dashboard/squad/more")).toBeNull();
    expect(parseUiRoute("/org/dashorg/dashboard/-/heatmap")).toBeNull();
    expect(parseUiRoute("/org/dashorg/dashboard/-/heatmap/squad")).toBeNull();
    expect(parseUiRoute("/org/%zz/dashboard")).toBeNull();
    expect(parseUiRoute("/org/dashorg/dashboard/%zz")).toBeNull();
    // The bare /org/{org} shape stays the REPO-HOME family's (owner "org"
    // resolves to nothing at handler time — the create-time reservation).
    expect(parseUiRoute("/org/dashorg")).toEqual({ family: "home", owner: "org", repo: "dashorg", refSuffix: null });
    // The "org" first segment is create-time reserved (isReservedOwnerName —
    // SPEC-0003 §3): every deeper /org/{x} shape without a landed literal
    // stays engine-owned, so even the teams literal under it never claims.
    expect(parseUiRoute("/org/dashorg/teams")).toBeNull();
  });
});

// --- the member-only gate (the census's Open Issues #9 posture) ---------------

describe("the member-only gate on the mounted route", () => {
  let world: DashWorld;

  beforeEach(async () => {
    world = await seedDashWorld();
  });

  it("404-shells an anonymous GET (upstream RequireMember NotFound — NO login redirect)", async () => {
    const res = await getRoute("/org/dashorg/dashboard", null);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    // Upstream 404s the anonymous viewer — the response is the shell page,
    // never a login redirect (no Location header).
    expect(res.headers.get("location")).toBeNull();
  });

  it("404-shells a signed-in non-member and admits member/owner/site-admin", async () => {
    await expectNotFoundShell(await getRoute("/org/dashorg/dashboard", world.outsiderId));
    const member = await getRoute("/org/dashorg/dashboard", world.memberId);
    expect(member.status).toBe(200);
    expect(await member.text()).toContain("page-content dashboard feeds");
    const owner = await getRoute("/org/dashorg/dashboard", world.ownerId);
    expect(owner.status).toBe(200);
    const admin = await getRoute("/org/dashorg/dashboard", world.adminId);
    expect(admin.status).toBe(200);
  });

  it("307s a renamed org through the shared seam before the gate, and 404-shells the user namespace", async () => {
    await drizzle(env.DB).insert(userRedirects).values({ lowerName: "dashold", redirectUserId: world.org.id }).run();
    const renamed = await getRoute("/org/dashold/dashboard", world.memberId);
    expect(renamed.status).toBe(307);
    expect(renamed.headers.get("location")).toBe("/org/dashorg/dashboard");
    // A plain USER name behind the literal (upstream GetOrganizationByParams'
    // type gate) shells — even for that user themself.
    await expectNotFoundShell(await getRoute("/org/milo/dashboard", world.memberId));
  });
});

// --- the page shape (navbar, feeds, guide, sidebar) ---------------------------

describe("the page shape over the org feed", () => {
  let world: DashWorld;

  beforeEach(async () => {
    world = await seedDashWorld();
  });

  it("renders the dashboard chrome: the title pair, the switcher, the team filter, the Activities tab, the View button", async () => {
    const res = await getRoute("/org/dashorg/dashboard", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="dashorg - Dashboard" class="page-content dashboard feeds">');
    expect(html).toContain("<title>dashorg - Dashboard - cf-gitea</title>");
    // The context-user switcher: the header, the self item, the membership
    // items (otherorg rides beside dashorg, marked active here).
    expect(html).toContain("Switch Dashboard Context");
    expect(html).toContain('href="/org/otherorg/dashboard"');
    expect(html).toContain('href="/org/dashorg/dashboard"');
    // The owner's team filter: the header + the "All" item + the SPECIFIC
    // teams — the includes-all team (All Repos) is excluded, navbar.tmpl:67's
    // arm.
    expect(html).toContain("Filter by team repositories");
    expect(html).toContain('href="/org/dashorg/dashboard/Alpha%20Crew"');
    expect(html).toContain('href="/org/dashorg/dashboard/Solo%20Crew"');
    expect(html).not.toContain('href="/org/dashorg/dashboard/All Repos"');
    // The right menu: the ACTIVE Activities tab (PageIsNews) + View home.
    expect(html).toContain("Activities</a>");
    expect(html).toContain('href="/org/dashorg/dashboard">'); // the Activities href
    expect(html).toContain('href="/dashorg"'); // the View-home button target
    expect(html).toContain(">View dashorg</a>");
    // A PLAIN MEMBER's dropdown carries only the teams their visibility tier
    // admits (org.go:186-204's SearchTeam arms — Alpha Crew is milo's own
    // team; Solo Crew/All Repos are private and not his): the visible-teams
    // read, upstream-exact.
    const member = await getRoute("/org/dashorg/dashboard", world.memberId);
    expect(member.status).toBe(200);
    const memberHtml = await member.text();
    expect(memberHtml).toContain('href="/org/dashorg/dashboard/Alpha%20Crew"');
    expect(memberHtml).not.toContain('href="/org/dashorg/dashboard/Solo%20Crew"');
  });

  it("renders the org feed rows through the landed activity rendering", async () => {
    const res = await getRoute("/org/dashorg/dashboard", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The create_issue row: the actor link, the message segment, the issue
    // link and the content-stored title (feeds.tmpl's arms).
    expect(html).toContain('href="/milo"');
    expect(html).toContain("opened issue");
    expect(html).toContain('href="/dashorg/open-repo/issues/7"');
    expect(html).toContain("Pinned the matrix");
    // The create_repo row (the plain arm shows every org-receiver row).
    expect(html).toContain("created repository");
    expect(html).toContain('href="/dashorg/open-repo"');
  });

  it("renders the guide arm on an empty feed (upstream's Paginator.TotalPages=0 posture)", async () => {
    // A fresh org with zero org-receiver action rows (no recordAction
    // seeds) — dashboard.tmpl's else arm.
    const orgs = new OrgService(env.DB);
    await orgs.createOrg({ name: "freshorg", ownerId: world.ownerId, visibility: "public", now: T0 });
    const res = await getRoute("/org/freshorg/dashboard", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No Activity");
    expect(html).toContain('href="/explore/repos"');
    expect(html).toContain('href="/explore/users"');
    expect(html).not.toContain("opened issue"); // no feed rows
  });

  it("renders the sidebar: the doer-accessible repo rows, the count label, the + link", async () => {
    const res = await getRoute("/org/dashorg/dashboard", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="dashboard-repo-list"');
    expect(html).toContain("Repositories<div"); // the widget header + its count label
    expect(html).toContain('href="/repo/create?org=');
    // The owner sees all three repos (the §4.7 owner arm).
    expect(html).toContain('href="/dashorg/open-repo"');
    expect(html).toContain('href="/dashorg/secret-repo"');
    expect(html).toContain('href="/dashorg/extra-repo"');
  });
});

// --- the {team} tail (RequireTeamMember + the repo-set filter) -----------------

describe("the {team} tail's gate and feed filter", () => {
  let world: DashWorld;

  beforeEach(async () => {
    world = await seedDashWorld();
  });

  it("gates the team arm: owner/admin/on-team member pass, an off-team member and an unknown name 404-shell", async () => {
    const alphaHref = `/org/dashorg/dashboard/${encodeURIComponent("Alpha Crew")}`;
    expect((await getRoute(alphaHref, world.ownerId)).status).toBe(200);
    expect((await getRoute(alphaHref, world.adminId)).status).toBe(200);
    expect((await getRoute(alphaHref, world.memberId)).status).toBe(200); // milo is ON Alpha Crew
    // milo is NOT on Solo Crew — upstream's RequireTeamMember NotFound.
    await expectNotFoundShell(await getRoute(`/org/dashorg/dashboard/${encodeURIComponent("Solo Crew")}`, world.memberId));
    // An unknown team name is the resolved miss — the shell (org.go's
    // teamExists arm).
    await expectNotFoundShell(await getRoute("/org/dashorg/dashboard/nobody-here", world.ownerId));
    // Anonymous shells before any team work (RequireMember first).
    await expectNotFoundShell(await getRoute(alphaHref, null));
  });

  it("filters the team feed through the team's repo set: the extra-repo row shows on all-teams and hides on Alpha Crew", async () => {
    // The sidebar legitimately lists every accessible repo — the assertion
    // scopes to the FEED column (everything above #dashboard-repo-list).
    const feedColumn = (html: string): string => html.split('id="dashboard-repo-list"')[0] ?? "";

    const all = await getRoute("/org/dashorg/dashboard", world.ownerId);
    expect(all.status).toBe(200);
    const allHtml = await all.text();
    expect(feedColumn(allHtml)).toContain("/dashorg/extra-repo"); // the extra-repo row renders
    expect(feedColumn(allHtml)).toContain("/dashorg/open-repo");

    const alpha = await getRoute(`/org/dashorg/dashboard/${encodeURIComponent("Alpha Crew")}`, world.ownerId);
    expect(alpha.status).toBe(200);
    const alphaHtml = await alpha.text();
    expect(feedColumn(alphaHtml)).toContain("/dashorg/open-repo"); // covered by the team
    expect(feedColumn(alphaHtml)).not.toContain("/dashorg/extra-repo"); // outside the set — hidden
    expect(alphaHtml).toContain("/dashorg/extra-repo"); // the sidebar still lists it (public)
    // The team's name rides the dropdown's collapsed text (navbar.tmpl's
    // Team arm) and the Activities href keeps the team tail (navbar.tmpl:81).
    expect(alphaHtml).toContain("Alpha Crew");
    expect(alphaHtml).toContain('href="/org/dashorg/dashboard/Alpha%20Crew">');
  });

  it("paginates the feed at the landed 20-per-page cap and folds the junk page parameter", async () => {
    // 25 more create_repo rows in open-repo → 29 org rows total.
    for (let index = 1; index <= 25; index += 1) {
      await recordAction(env.DB, {
        actUserId: world.memberId,
        repoId: world.openRepoId,
        opType: ActionType.CreateRepo,
        isPrivate: false,
        createdAt: T0,
      });
    }
    const page1 = await getRoute("/org/dashorg/dashboard", world.ownerId);
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain('href="/org/dashorg/dashboard?page=2"');
    expect(html1).toContain("<span class=\"navigation_label\">Older</span>");
    expect(html1).not.toContain("Newer</span>"); // nothing older than page 1

    const page2 = await getRoute("/org/dashorg/dashboard?page=2", world.ownerId);
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain('href="/org/dashorg/dashboard"'); // Newer: the canonical page-1 href drops the query
    expect(html2).toContain("Newer</span>");
    expect(html2).not.toContain("Older</span>"); // 29 total: page 2 is the last

    // The junk page parameter folds onto page 1 (parsePageNumber's arm).
    const junk = await getRoute("/org/dashorg/dashboard?page=abc", world.ownerId);
    expect(junk.status).toBe(200);
    expect(await junk.text()).toContain('href="/org/dashorg/dashboard?page=2"');
  });

  it("applies the ?date window (FeedDateCond) — a non-matching date renders the guide", async () => {
    const hit = await getRoute("/org/dashorg/dashboard?date=2023-11-14", world.ownerId);
    expect(hit.status).toBe(200);
    const hitHtml = await hit.text();
    expect(hitHtml).not.toContain("No Activity"); // T0 rows land in the window
    expect(hitHtml).toContain("opened issue");

    const miss = await getRoute("/org/dashorg/dashboard?date=2024-06-01", world.ownerId);
    expect(miss.status).toBe(200);
    const missHtml = await miss.text();
    expect(missHtml).toContain("No Activity"); // empty window → the guide arm
    expect(missHtml).not.toContain("opened issue");
    // An unparsable date skips the filter (FeedDateCond's warn-and-continue).
    const junk = await getRoute("/org/dashorg/dashboard?date=nonsense", world.ownerId);
    expect(junk.status).toBe(200);
    expect(await junk.text()).toContain("opened issue");
  });
});
