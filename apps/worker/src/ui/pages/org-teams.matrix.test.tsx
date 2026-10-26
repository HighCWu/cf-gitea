/**
 * The ORG TEAMS family's DEFERRED route-level matrix (the polish wave, after
 * the wave-12 mount — pages/org-teams.tsx over index.ts's orgTeams*
 * handlers — and the wave-49 team edit/delete tails in
 * pages/org-settings.tsx): the MINTED-SESSION route arms driven through
 * `uiRouter.fetch()` on the real production path (parse → resolveUiSession →
 * the shared org-teams prologue → load → render — the org-settings-hooks
 * matrix's pattern), one fresh org world per test behind per-test table
 * wipes. The shared-fixture suites keep the base arms and are NOT repeated
 * here: ui/__tests__/pages-wave12.test.ts owns the parser claims, the list
 * gate + `?q=` filter, the detail slice's owner/foreign-id renders and the
 * create form's gates/typed-422s; ui/__tests__/pages-wave49-org-settings.test.ts
 * owns the edit/delete shapes, the owner's edit/delete round-trips and the
 * last-owner refusal. THIS file adds the arms those suites do not carry:
 *
 *   - the claim pins the family never pinned: the trailing-slash folds of
 *     every wildcard shape (wave-12 pinned the bare list only), the `/^\d+$/`
 *     claim's zero and int64-overflow edges, the junk-tail carriers
 *     (`+1`, `1.5`, `-1`, malformed percent-encoding) and the route-level
 *     trailing-slash canonicalization with the POST write NOT laundered;
 *   - the anon 303s on the wave-49 POST tails (edit + delete — wave-12 pinned
 *     only the new arm): the login round-trip carries the POSTED path and
 *     nothing is written; the non-owner (plain member AND outsider) write
 *     POSTs 404-shell before any write;
 *   - the gate's user-owner namespace arms on every shape (wave-12 pinned
 *     the list only) and the site-admin admission on the edit arm;
 *   - the §2.8 cross-origin 403s on ALL THREE write arms — sameOriginGuard
 *     runs FIRST, so a valid session cookie still 403s and a cookie-less
 *     probe 403s rather than 303ing onto login; the Origin-less Referer
 *     fallback rejects a foreign referer, admits the same-origin one
 *     end-to-end, and the header-less probe rides past the guard into the
 *     session gate;
 *   - the renamed-org 307 through the shared resolveOrgForRequest seam on
 *     the detail/create/edit shapes (wave-12 pinned the list only) — the
 *     anonymous list arm proves the seam precedes the login 303, and the
 *     same-origin write POSTs 307 before any write;
 *   - the list shape beyond wave-12's single-row render: the full visibility
 *     badge trio with their tooltip helpers, the Read/Administrator Access
 *     permission labels, the units team's badge-less row, the member-strip
 *     isolation across rows, the page-1/page-2 pagination split with the
 *     keyword-preserving pager hrefs, the junk `?page=` fold and the
 *     zero-team / no-match empty grids;
 *   - the detail slice's permission-section arms: the admin desc paragraph,
 *     the stored units table, the can_create_org_repo list item, the
 *     no-description span and the EMPTY members/repositories lists;
 *   - the create form's parse edges: the out-of-enum permission's "no
 *     permission specified" 422 re-render (the landed validator's arm),
 *     the whitespace-name trim, and the reserved `new` name's bare 500
 *     propagation (the module header's documented arm);
 *   - the wave-49 edit/delete tails' id gaps: a foreign-org id 404-shells
 *     GET and BOTH POSTs (existence stays hidden, the rival team survives)
 *     and the zero id shells like the unknown one.
 *
 * The fixture org is `teamorgmx` (nadia owner, milo plain member, adminmx
 * site admin; vera owns only the `rivaltmx` rival org whose team is the
 * foreign-id carrier), seeded through the LANDED OrgService/TeamsService/
 * RepoService arms — ids are captured at seed time, never hardcoded (the
 * wipe does not reset the AUTOINCREMENT counters).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { TeamsService, type TeamRecord } from "../../api/routes/org-teams";
import { teams, userRedirects } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** Tables the fixtures and the write arms touch (children first — the
 *  blocked-users harness's cleanup-list convention; "sessions" explicit
 *  because the route matrix mints session rows per request). */
const FIXTURE_TABLES = [
  "webhook_deliveries",
  "webhooks",
  "team_repo_access",
  "team_members",
  "teams",
  "repo_collaborators",
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

/** The route world's REAL rows (the routes resolve through OrgService and the
 *  landed TeamsService arms — nothing is hand-inserted into `teams`): the
 *  teamorgmx org with nadia as owner and milo as a plain member, adminmx as
 *  the site admin, vera's rivaltmx org for the foreign-scope arms, two repos
 *  (public + private), and five teams covering every permission/visibility
 *  shape. Ids are captured at seed time — never hardcoded. */
interface TeamsWorld {
  org: OrgRecord;
  ownerId: number; // nadia
  memberId: number; // milo (inside, but no ownership)
  outsiderId: number; // vera (owns only rivaltmx)
  adminId: number; // adminmx (site admin)
  rivalOrgId: number;
  alphaTeamId: number; // blanket write team, 2 members + 2 repos
  publicTeamId: number; // read + public + can_create_org_repo, no members/repos
  limitedTeamId: number; // read + limited + includes-all
  unitTeamId: number; // per-unit map team
  adminTeamId: number; // blanket admin team
  rivalTeamId: number; // rivaltmx's team (the foreign-id carrier)
}

async function seedTeamsWorld(): Promise<TeamsWorld> {
  const owner = await seedVerifiedUser({ username: "nadia" });
  const member = await seedVerifiedUser({ username: "milo" });
  const outsider = await seedVerifiedUser({ username: "vera" });
  const admin = await seedVerifiedUser({ username: "adminmx", isAdmin: true });

  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "teamorgmx", ownerId: owner.id, visibility: "public", now: T0 });
  await orgs.addMember(org.id, member.id, { now: T0 });
  const rival = await orgs.createOrg({ name: "rivaltmx", ownerId: outsider.id, visibility: "public", now: T0 });

  const repoService = new RepoService(env.DB);
  const open = await repoService.create({
    owner: { id: org.id, usernameLower: "teamorgmx" },
    name: "open-repo",
    isPrivate: false,
    status: "ready",
  });
  const secret = await repoService.create({
    owner: { id: org.id, usernameLower: "teamorgmx" },
    name: "secret-repo",
    isPrivate: true,
    status: "ready",
  });

  const service = new TeamsService(env.DB);
  const alpha = await service.createTeam(org, {
    name: "Alpha Crew",
    permission: "write",
    description: "Ships the matrix.",
  });
  await service.addTeamMember(alpha, owner.id);
  await service.addTeamMember(alpha, member.id);
  await service.addTeamRepo(alpha, open.id);
  await service.addTeamRepo(alpha, secret.id);
  const publicTeam = await service.createTeam(org, {
    name: "Public Squad",
    permission: "read",
    visibility: "public",
    can_create_org_repo: true,
  });
  const limited = await service.createTeam(org, {
    name: "Limited Ring",
    permission: "read",
    visibility: "limited",
    includes_all_repositories: true,
  });
  const unit = await service.createTeam(org, {
    name: "Unit Crew",
    units_map: { "repo.code": "write", "repo.issues": "read" },
  });
  const adminTeam = await service.createTeam(org, { name: "Admin Squad", permission: "admin" });
  const rivalTeam = await service.createTeam(rival, { name: "Rival Team", permission: "read" });

  return {
    org,
    ownerId: owner.id,
    memberId: member.id,
    outsiderId: outsider.id,
    adminId: admin.id,
    rivalOrgId: rival.id,
    alphaTeamId: alpha.id,
    publicTeamId: publicTeam.id,
    limitedTeamId: limited.id,
    unitTeamId: unit.id,
    adminTeamId: adminTeam.id,
    rivalTeamId: rivalTeam.id,
  };
}

// --- the mounted-route harness (the org-settings-hooks matrix pattern) ----------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the org-teams
 *  prologue → load → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A viewer's minted session cookie header (the real mintSession path, minted
 *  per request — the beforeEach users wipe cascades the sessions table, so a
 *  cross-test cache would go stale; the value is never rendered). */
async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A GET through the mount (`userId: null` is the anonymous arm). */
async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

/** A urlencoded POST through the mount: the explicit cookie (null =
 *  anonymous) and Origin (null = the Origin-less probe) are independent —
 *  the §2.8 guard and the session gate are separate layers, and the referer
 *  arms exercise sameOriginGuard's fallback branch. */
async function postArm(
  path: string,
  userId: number | null,
  fields: Record<string, string>,
  origin: string | null = ORIGIN,
  referer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  if (userId !== null) headers.cookie = await sessionCookie(userId);
  return fetchUi(path, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

/** The 404 fidelity every missing arm shares: the shell answers, never the
 *  teams pages' content. */
async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain("status-page-error"); // the 404 shell
  expect(html).not.toContain("page-content organization teams"); // never the list
  expect(html).not.toContain("page-content organization new team"); // never the forms
}

/** The org's whole `teams` store (ordered by id), for the nothing-written
 *  assertions. */
async function allTeams(): Promise<TeamRecord[]> {
  return drizzle(env.DB).select().from(teams).all();
}

/** One team by id through the landed read (null when gone). */
async function teamById(id: number): Promise<TeamRecord | null> {
  return new TeamsService(env.DB).getTeamById(id);
}

// --- the claim pins (parseUiRoute / handlesUiRoute + the mount's middleware) ----

describe("org-teams family claim pins (the folds and edges wave-12 never pinned)", () => {
  it("canonicalizes the trailing-slash form of every wildcard shape", () => {
    expect(parseUiRoute("/acme/teams/new/")).toEqual({ family: "org-team-new", owner: "acme" });
    expect(parseUiRoute("/acme/teams/42/")).toEqual({ family: "org-team-detail", owner: "acme", id: 42 });
    expect(parseUiRoute("/acme/teams/42/edit/")).toEqual({ family: "org-team-edit", owner: "acme", id: 42 });
    expect(parseUiRoute("/acme/teams/42/delete/")).toEqual({ family: "org-team-delete", owner: "acme", id: 42 });
    expect(parseUiRoute("/acme/teams/0/")).toEqual({ family: "org-team-detail", owner: "acme", id: 0 });
    expect(handlesUiRoute("/acme/teams/42/edit/")).toBe(true);
  });

  it("claims the digit edges and leaves the junk carriers with the engine", () => {
    // /^\d+$/ admits "0" (the resolve shells it — the detail arm below) and
    // the int64-overflow digits (parseInt folds to 1e20; getTeamById misses).
    expect(parseUiRoute("/acme/teams/0")).toEqual({ family: "org-team-detail", owner: "acme", id: 0 });
    expect(parseUiRoute("/acme/teams/99999999999999999999")).toEqual({
      family: "org-team-detail",
      owner: "acme",
      id: 100000000000000000000,
    });
    expect(parseUiRoute("/acme/teams/0/edit")).toEqual({ family: "org-team-edit", owner: "acme", id: 0 });
    // Junk carriers stay unclaimed → the engine's 404.
    expect(parseUiRoute("/acme/teams/+1")).toBeNull();
    expect(parseUiRoute("/acme/teams/1.5")).toBeNull();
    expect(parseUiRoute("/acme/teams/-1")).toBeNull();
    expect(parseUiRoute("/acme/teams/%zz")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/%zz")).toBeNull();
    expect(parseUiRoute("/acme/teams/42/delete/x")).toBeNull();
    expect(handlesUiRoute("/acme/teams/not-a-number")).toBe(false);
    expect(handlesUiRoute("/acme/teams/42/delete/x")).toBe(false);
  });

  it("301s the trailing-slash GETs onto the canonical URLs (query preserved) and never launders a slashed POST write", async () => {
    const world = await seedTeamsWorld();
    // The list with a query: the middleware's default mode answers the 404
    // with a 301 whose absolute location keeps it (c.redirect's URL form).
    const list = await getRoute("/teamorgmx/teams/?q=x", null);
    expect(list.status).toBe(301);
    expect(list.headers.get("location")).toBe(`${ORIGIN}/teamorgmx/teams?q=x`);
    // The detail wildcard.
    const detail = await getRoute(`/teamorgmx/teams/${world.alphaTeamId}/`, world.ownerId);
    expect(detail.status).toBe(301);
    expect(detail.headers.get("location")).toBe(`${ORIGIN}/teamorgmx/teams/${world.alphaTeamId}`);
    // The create form literal.
    const form = await getRoute("/teamorgmx/teams/new/", world.ownerId);
    expect(form.status).toBe(301);
    expect(form.headers.get("location")).toBe(`${ORIGIN}/teamorgmx/teams/new`);
    // A slashed POST is GET/HEAD-only in the middleware — it stays a 404 and
    // can never launder into the write (the create count is untouched).
    const slashedPost = await postArm("/teamorgmx/teams/new/", world.ownerId, {
      team_name: "Slashed",
      permission: "read",
    });
    expect(slashedPost.status).toBe(404);
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
  });
});

// --- the gates (the shared org-teams prologue) -----------------------------------

describe("the gate posture on the mounted routes (the arms wave-12/wave-49 never pinned)", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
  });

  it("303s an anonymous GET of every shape onto the login round-trip and 405s the delete GET before any session work", async () => {
    for (const path of [
      "/teamorgmx/teams",
      `/teamorgmx/teams/${world.alphaTeamId}`,
      "/teamorgmx/teams/new",
      `/teamorgmx/teams/${world.alphaTeamId}/edit`,
    ]) {
      const res = await getRoute(path, null);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
    // The delete tail is POST-only: chi's 405 answers before the session
    // gate is even consulted.
    const deleteGet = await getRoute(`/teamorgmx/teams/${world.alphaTeamId}/delete`, null);
    expect(deleteGet.status).toBe(405);
  });

  it("303s an anonymous same-origin edit/delete POST onto the login round-trip carrying the POSTED path — nothing written", async () => {
    const edit = await postArm(`/teamorgmx/teams/${world.alphaTeamId}/edit`, null, { team_name: "Hijacked" });
    expect(edit.status).toBe(303);
    expect(edit.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/teamorgmx/teams/${world.alphaTeamId}/edit`)}`,
    );
    const del = await postArm(`/teamorgmx/teams/${world.alphaTeamId}/delete`, null, {});
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/teamorgmx/teams/${world.alphaTeamId}/delete`)}`,
    );
    // D1 read-backs: the name is untouched and the team survives.
    const alpha = await teamById(world.alphaTeamId);
    expect(alpha?.name).toBe("Alpha Crew");
    expect(await teamById(world.alphaTeamId)).not.toBeNull();
  });

  it("404-shells the non-owner write POSTs (plain member AND outsider) before any write", async () => {
    for (const userId of [world.memberId, world.outsiderId]) {
      await expectNotFoundShell(
        await postArm("/teamorgmx/teams/new", userId, { team_name: "Pal Crew", permission: "admin" }),
      );
      await expectNotFoundShell(
        await postArm(`/teamorgmx/teams/${world.alphaTeamId}/edit`, userId, { team_name: "Hijacked Crew" }),
      );
      await expectNotFoundShell(await postArm(`/teamorgmx/teams/${world.alphaTeamId}/delete`, userId, {}));
    }
    // Nothing written: the five seeds only, Alpha intact.
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
    expect((await teamById(world.alphaTeamId))?.name).toBe("Alpha Crew");
  });

  it("404-shells a USER namespace on every shape (the owner segment is not an org)", async () => {
    for (const path of [
      "/vera/teams",
      "/vera/teams/42",
      "/vera/teams/new",
      "/vera/teams/42/edit",
    ]) {
      await expectNotFoundShell(await getRoute(path, world.outsiderId));
    }
  });

  it("admits the site admin onto the edit arm and its write (the wave-49 suite pinned the org owner only)", async () => {
    const get = await getRoute(`/teamorgmx/teams/${world.alphaTeamId}/edit`, world.adminId);
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain("page-content organization new team");
    expect(html).toContain(`action="/teamorgmx/teams/${world.alphaTeamId}/edit" method="post"`);
    expect(html).toContain('value="Alpha Crew"');
    expect(html).toContain('value="write" checked');

    const post = await postArm(`/teamorgmx/teams/${world.alphaTeamId}/edit`, world.adminId, {
      team_name: "Alpha Crew Admin Renamed",
      description: "Renamed by the admin.",
      visibility: "private",
      permission: "write",
    });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/teamorgmx/teams/${world.alphaTeamId}`);
    const row = await teamById(world.alphaTeamId);
    expect(row?.name).toBe("Alpha Crew Admin Renamed");
    expect(row?.authorize).toBe("write");
  });
});

// --- the §2.8 guard (sameOriginGuard runs FIRST on all three write arms) ---------

describe("the §2.8 cross-origin 403s on all three write arms (the arms wave-12 pinned on the new arm only)", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
  });

  it("403s a cross-origin POST ahead of every gate — even with a valid owner cookie — and nothing is written", async () => {
    for (const [path, fields] of [
      ["/teamorgmx/teams/new", { team_name: "Evil Crew", permission: "admin" }],
      [`/teamorgmx/teams/${world.alphaTeamId}/edit`, { team_name: "Evil Crew" }],
      [`/teamorgmx/teams/${world.alphaTeamId}/delete`, {}],
    ] as const) {
      const res = await postArm(path, world.ownerId, fields, "https://evil.example");
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cross-origin request rejected");
    }
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
    expect((await teamById(world.alphaTeamId))?.name).toBe("Alpha Crew");
  });

  it("403s the cookie-less cross-origin probe instead of 303ing onto login (the guard precedes the session gate)", async () => {
    for (const [path, fields] of [
      ["/teamorgmx/teams/new", { team_name: "Ghost Crew", permission: "read" }],
      [`/teamorgmx/teams/${world.alphaTeamId}/edit`, { team_name: "Ghost Crew" }],
      [`/teamorgmx/teams/${world.alphaTeamId}/delete`, {}],
    ] as const) {
      const res = await postArm(path, null, fields, "https://evil.example");
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cross-origin request rejected");
    }
    expect(await teamById(world.alphaTeamId)).not.toBeNull();
  });

  it("falls back to the Referer when Origin is absent — foreign rejects, same-origin admits, header-less rides into the session gate", async () => {
    // Foreign referer, delete arm: 403, the team survives.
    const foreign = await postArm(`/teamorgmx/teams/${world.alphaTeamId}/delete`, world.ownerId, {}, null, "https://evil.example/admin");
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toContain("cross-origin request rejected");
    expect(await teamById(world.alphaTeamId)).not.toBeNull();
    // Same-origin referer, edit arm: the write proceeds end-to-end.
    const admitted = await postArm(
      `/teamorgmx/teams/${world.alphaTeamId}/edit`,
      world.ownerId,
      { team_name: "Alpha Crew Referred", visibility: "private", permission: "write" },
      null,
      `${ORIGIN}/teamorgmx/teams/${world.alphaTeamId}/edit`,
    );
    expect(admitted.status).toBe(303);
    expect((await teamById(world.alphaTeamId))?.name).toBe("Alpha Crew Referred");
    // Header-less anonymous delete: the guard passes, the session gate 303s
    // onto the login round-trip, nothing is deleted.
    const headerless = await postArm(`/teamorgmx/teams/${world.alphaTeamId}/delete`, null, {}, null);
    expect(headerless.status).toBe(303);
    expect(headerless.headers.get("location")).toContain("/login?redirect_to=");
    expect(await teamById(world.alphaTeamId)).not.toBeNull();
  });
});

// --- the renamed-org seam (the shared resolveOrgForRequest 307) -------------------

describe("the renamed-org 307 across the family (wave-12 pinned the list arm only)", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
    await drizzle(env.DB)
      .insert(userRedirects)
      .values({ lowerName: "teamoldmx", redirectUserId: world.org.id })
      .run();
  });

  it("rewrites the old-name segment with the query preserved — anon included, and before any same-origin write", async () => {
    // Anonymous list arm: the seam precedes the login 303 in the prologue.
    const anon = await getRoute("/teamoldmx/teams", null);
    expect(anon.status).toBe(307);
    expect(anon.headers.get("location")).toBe("/teamorgmx/teams");
    // The detail wildcard with a query.
    const detail = await getRoute(`/teamoldmx/teams/${world.alphaTeamId}?q=x`, world.ownerId);
    expect(detail.status).toBe(307);
    expect(detail.headers.get("location")).toBe(`/teamorgmx/teams/${world.alphaTeamId}?q=x`);
    // The create form literal.
    const form = await getRoute("/teamoldmx/teams/new", world.ownerId);
    expect(form.status).toBe(307);
    expect(form.headers.get("location")).toBe("/teamorgmx/teams/new");
    // A same-origin edit write 307s BEFORE the write (the team is untouched).
    const editPost = await postArm(`/teamoldmx/teams/${world.alphaTeamId}/edit`, world.ownerId, {
      team_name: "Renamed Under Old Name",
    });
    expect(editPost.status).toBe(307);
    expect(editPost.headers.get("location")).toBe(`/teamorgmx/teams/${world.alphaTeamId}/edit`);
    expect((await teamById(world.alphaTeamId))?.name).toBe("Alpha Crew");
    // The create write likewise (count untouched).
    const createPost = await postArm("/teamoldmx/teams/new", world.ownerId, {
      team_name: "Created Under Old Name",
      permission: "read",
    });
    expect(createPost.status).toBe(307);
    expect(createPost.headers.get("location")).toBe("/teamorgmx/teams/new");
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
    // The target answers 200 behind the new name.
    const target = await getRoute("/teamorgmx/teams", world.ownerId);
    expect(target.status).toBe(200);
    expect(await target.text()).toContain("page-content organization teams");
  });
});

// --- the list shape + access badges (beyond wave-12's single-row render) ---------

describe("the list shape: the badge trio, the strip isolation, the pagination", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
  });

  it("renders the visibility badge trio with their tooltip helpers and the permission labels — a units team carries the visibility badge only", async () => {
    const res = await getRoute("/teamorgmx/teams", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    const boxes = html.split("team-item-box").slice(1);
    expect(boxes).toHaveLength(5); // five teams, one box each

    const alphaBox = boxes.find((box) => box.includes("<strong>Alpha Crew</strong>"))!;
    expect(alphaBox).toContain('data-tooltip-content="Visible only to team members and organization owners."');
    expect(alphaBox).toContain(">Write</span>"); // the permission label rides beside it

    const publicBox = boxes.find((box) => box.includes("<strong>Public Squad</strong>"))!;
    expect(publicBox).toContain('data-tooltip-content="Visible to any signed-in user.">Public</span>');
    expect(publicBox).toContain(">Read</span>");

    const limitedBox = boxes.find((box) => box.includes("<strong>Limited Ring</strong>"))!;
    expect(limitedBox).toContain('data-tooltip-content="Visible to all members of this organization.">Limited</span>');
    expect(limitedBox).toContain(">Read</span>");

    const adminBox = boxes.find((box) => box.includes("<strong>Admin Squad</strong>"))!;
    expect(adminBox).toContain(">Administrator Access</span>");

    // The units team (authorize none) renders NO permission label — exactly
    // one badge, the visibility one.
    const unitBox = boxes.find((box) => box.includes("<strong>Unit Crew</strong>"))!;
    expect(unitBox.split('class="ui mini label"')).toHaveLength(2); // open+close → one badge
    expect(unitBox).not.toContain(">Read</span>");
    expect(unitBox).not.toContain(">Write</span>");
    expect(unitBox).not.toContain(">Administrator Access</span>");
  });

  it("keeps every row's member strip to its own team (names, counts, and the empty strip)", async () => {
    const res = await getRoute("/teamorgmx/teams", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    const boxes = html.split("team-item-box").slice(1);

    const alphaBox = boxes.find((box) => box.includes("<strong>Alpha Crew</strong>"))!;
    expect(alphaBox).toContain('href="/nadia"');
    expect(alphaBox).toContain('href="/milo"');
    expect(alphaBox).toContain("2 members");
    expect(alphaBox).toContain("2 repositories");

    const publicBox = boxes.find((box) => box.includes("<strong>Public Squad</strong>"))!;
    expect(publicBox).not.toContain('href="/nadia"');
    expect(publicBox).not.toContain('href="/milo"');
    expect(publicBox).toContain("0 members");
    expect(publicBox).toContain("0 repositories");
  });

  it("paginates at the landed 20-per-page cap and folds the junk page parameter", async () => {
    // 5 fixture teams + 17 bulk teams = 22 → two pages, the bulk names
    // sorting between "alpha crew" and "limited ring".
    const service = new TeamsService(env.DB);
    for (let index = 1; index <= 17; index += 1) {
      await service.createTeam(world.org, { name: `bulk-${String(index).padStart(2, "0")}`, permission: "read" });
    }
    const page1 = await getRoute("/teamorgmx/teams", world.ownerId);
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain("<strong>Alpha Crew</strong>"); // the 5 fixture teams lead the sort
    expect(html1).toContain("<strong>Limited Ring</strong>"); // the 20th row
    expect(html1).not.toContain("<strong>Unit Crew</strong>"); // pushed to page 2
    expect(html1).toContain('href="/teamorgmx/teams?page=2"');
    expect(html1).toContain("<span class=\"navigation_label\">Older</span>");
    expect(html1).not.toContain("Newer</span>"); // nothing older than page 1

    const page2 = await getRoute("/teamorgmx/teams?page=2", world.ownerId);
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain("<strong>Unit Crew</strong>");
    expect(html2).not.toContain("<strong>Alpha Crew</strong>");
    expect(html2).toContain('href="/teamorgmx/teams?page=1"');
    expect(html2).toContain("Newer</span>");
    expect(html2).not.toContain("Older</span>"); // 22 total: page 2 is the last

    // The junk page parameter folds onto page 1 (parsePageNumber's arm).
    const junk = await getRoute("/teamorgmx/teams?page=abc", world.ownerId);
    expect(junk.status).toBe(200);
    expect(await junk.text()).toContain("<strong>Alpha Crew</strong>");
  });

  it("preserves the q keyword through the pagination hrefs and the search input, and renders the empty grids", async () => {
    // 21 keyword matches → the keyword-prefixed pager hrefs on both pages.
    const service = new TeamsService(env.DB);
    for (let index = 1; index <= 21; index += 1) {
      await service.createTeam(world.org, { name: `kwteam-${String(index).padStart(2, "0")}`, permission: "read" });
    }
    const page1 = await getRoute("/teamorgmx/teams?q=kwteam", world.ownerId);
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain('value="kwteam"'); // the search input keeps the keyword
    expect(html1).toContain('href="/teamorgmx/teams?q=kwteam&amp;page=2"');
    const page2 = await getRoute("/teamorgmx/teams?q=kwteam&page=2", world.ownerId);
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain('href="/teamorgmx/teams?q=kwteam&amp;page=1"');

    // A keyword matching nothing renders the empty grid with the keyword kept.
    const noMatch = await getRoute("/teamorgmx/teams?q=zzz-none", world.ownerId);
    expect(noMatch.status).toBe(200);
    const noMatchHtml = await noMatch.text();
    expect(noMatchHtml).toContain('value="zzz-none"');
    expect(noMatchHtml).not.toContain("team-item-box");
    expect(noMatchHtml).toContain("Members are managed through teams."); // the prompt row stays

    // A zero-team org renders the empty grid too (upstream's no-empty-state
    // posture) with the prompt row and the search form.
    const orgs = new OrgService(env.DB);
    await orgs.createOrg({ name: "emptytmx", ownerId: world.ownerId, visibility: "public", now: T0 });
    const empty = await getRoute("/emptytmx/teams", world.ownerId);
    expect(empty.status).toBe(200);
    const emptyHtml = await empty.text();
    expect(emptyHtml).toContain("page-content organization teams");
    expect(emptyHtml).toContain(`action="/emptytmx/teams"`);
    expect(emptyHtml).not.toContain("team-item-box");
    expect(emptyHtml).toContain("Members are managed through teams.");
  });
});

// --- the detail slice's permission-section arms ----------------------------------

describe("the detail slice's sidebar arms (the permission shapes wave-12 never rendered)", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
  });

  it("renders the write team's full slice: description, specific-repos access, both lists, the Settings entry link", async () => {
    const res = await getRoute(`/teamorgmx/teams/${world.alphaTeamId}`, world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization teams");
    // The sidebar: name + badges, the stored description, the access section.
    expect(html).toContain("<strong>Alpha Crew</strong>");
    expect(html).toContain("Ships the matrix.");
    expect(html).toContain("<li>Specific repositories</li>");
    expect(html).toContain("This team grants <strong>Write</strong> access");
    // The members list (both principals) and the repo-access list (public +
    // private — the owner gate reads both).
    expect(html).toContain('href="/nadia"');
    expect(html).toContain('href="/milo"');
    expect(html).toContain(">teamorgmx/open-repo</a>");
    expect(html).toContain(">teamorgmx/secret-repo</a>");
    // The wave-49 entry link onto the edit form.
    expect(html).toContain(`href="/teamorgmx/teams/${world.alphaTeamId}/edit"`);
  });

  it("renders the admin desc paragraph and the Administrator Access badge for the admin team", async () => {
    const res = await getRoute(`/teamorgmx/teams/${world.adminTeamId}`, world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "This team grants <strong>Admin</strong> access: members can read from, push to and add collaborators to team repositories.",
    );
    expect(html).toContain(">Administrator Access</span>");
  });

  it("renders a units team's stored per-unit rows in the sidebar table", async () => {
    const res = await getRoute(`/teamorgmx/teams/${world.unitTeamId}`, world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<table class="ui table">');
    // The sorted unit rows: repo.code → Write, repo.issues → Read.
    expect(html).toContain("<strong>repo.code</strong>");
    expect(html.indexOf("<strong>repo.code</strong>")).toBeLessThan(html.indexOf("<strong>repo.issues</strong>"));
    expect(html).toContain("<td>Write</td>");
    expect(html).toContain("<td>Read</td>");
  });

  it("renders the empty arms: no description, the can_create_org_repo item, the memberless + repoless lists — and the includes-all fan-out on the limited team", async () => {
    const publicRes = await getRoute(`/teamorgmx/teams/${world.publicTeamId}`, world.ownerId);
    expect(publicRes.status).toBe(200);
    const publicHtml = await publicRes.text();
    expect(publicHtml).toContain("This team has no description");
    expect(publicHtml).toContain("<li>Create repositories</li>");
    expect(publicHtml).toContain("<h3>Permission</h3><p>Read</p>");
    expect(publicHtml).toContain("No members on this team.");
    expect(publicHtml).toContain("No repositories could be accessed by this team.");

    const limitedRes = await getRoute(`/teamorgmx/teams/${world.limitedTeamId}`, world.ownerId);
    expect(limitedRes.status).toBe(200);
    const limitedHtml = await limitedRes.text();
    expect(limitedHtml).toContain("<li>All repositories</li>");
    // The includes-all fan-out covered the org's repos at create.
    expect(limitedHtml).toContain(">teamorgmx/open-repo</a>");
    expect(limitedHtml).toContain(">teamorgmx/secret-repo</a>");
  });

  it("404-shells the zero and overflow ids the parser claims, and leaves the junk tail plainly 404", async () => {
    // id 0 and the folded overflow claim parse but never resolve — the shell
    // answers, existence stays hidden.
    await expectNotFoundShell(await getRoute("/teamorgmx/teams/0", world.ownerId));
    await expectNotFoundShell(await getRoute("/teamorgmx/teams/0/edit", world.ownerId));
    await expectNotFoundShell(await getRoute("/teamorgmx/teams/99999999999999999999", world.ownerId));
    // A junk tail is UNCLAIMED — the plain not-found answers, never the shell.
    const junk = await getRoute("/teamorgmx/teams/not-a-number", world.ownerId);
    expect(junk.status).toBe(404);
    const junkHtml = await junk.text();
    expect(junkHtml).not.toContain("status-page-error");
    expect(junkHtml).not.toContain("page-content organization teams");
  });
});

// --- the create form's parse edges (beyond wave-12's typed 422s) ------------------

describe("the create form's parse edges", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
  });

  it("re-renders the out-of-enum permission as the landed validator's 422 with the kept name (nothing written)", async () => {
    const res = await postArm("/teamorgmx/teams/new", world.ownerId, {
      team_name: "Carried Name",
      permission: "maintainer",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization new team");
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("no permission specified");
    expect(html).toContain('value="Carried Name"');
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
  });

  it("trims the submitted name before the empty guard and on the success path", async () => {
    // Whitespace-only folds onto the empty-name 422.
    const blank = await postArm("/teamorgmx/teams/new", world.ownerId, {
      team_name: "   ",
      permission: "read",
    });
    expect(blank.status).toBe(200);
    expect(await blank.text()).toContain("empty team name");
    // A padded name trims to its display form and creates.
    const padded = await postArm("/teamorgmx/teams/new", world.ownerId, {
      team_name: "  Trimmed Crew  ",
      permission: "read",
    });
    expect(padded.status).toBe(303);
    const created = (await allTeams()).find((team) => team.lowerName === "trimmed crew");
    expect(created?.name).toBe("Trimmed Crew");
  });

  it("propagates the reserved `new` name's bare 500 (the module header's documented arm) without creating a row", async () => {
    const res = await postArm("/teamorgmx/teams/new", world.ownerId, {
      team_name: "new",
      permission: "read",
    });
    expect(res.status).toBe(500);
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
  });
});

// --- the wave-49 edit/delete tails' id gaps ---------------------------------------

describe("the edit/delete tails' id fidelity (the foreign and unknown carriers wave-49 never drove)", () => {
  let world: TeamsWorld;

  beforeEach(async () => {
    world = await seedTeamsWorld();
  });

  it("404-shells a foreign-org id on the edit GET and BOTH write POSTs — the rival team survives", async () => {
    await expectNotFoundShell(await getRoute(`/teamorgmx/teams/${world.rivalTeamId}/edit`, world.ownerId));
    await expectNotFoundShell(
      await postArm(`/teamorgmx/teams/${world.rivalTeamId}/edit`, world.ownerId, { team_name: "Captured" }),
    );
    await expectNotFoundShell(await postArm(`/teamorgmx/teams/${world.rivalTeamId}/delete`, world.ownerId, {}));
    // The rival org's team is untouched behind its own gate.
    const rival = await teamById(world.rivalTeamId);
    expect(rival?.name).toBe("Rival Team");
    expect(rival?.orgId).toBe(world.rivalOrgId);
    // And Alpha never saw the foreign id's writes.
    expect((await teamById(world.alphaTeamId))?.name).toBe("Alpha Crew");
  });

  it("404-shells the unknown id on both write POSTs (wave-49 pinned the edit GET only)", async () => {
    await expectNotFoundShell(await postArm("/teamorgmx/teams/999999/edit", world.ownerId, { team_name: "Nobody" }));
    await expectNotFoundShell(await postArm("/teamorgmx/teams/999999/delete", world.ownerId, {}));
    expect((await allTeams()).filter((team) => team.orgId === world.org.id)).toHaveLength(5);
  });

  it("keeps the org-teams gate off the rival owner's cross-org reads: vera sees only her own org's slices", async () => {
    // Vera (rivaltmx's owner) is exactly the foreign arm's mirror: her own
    // detail answers, teamorgmx's never does.
    const own = await getRoute(`/rivaltmx/teams/${world.rivalTeamId}`, world.outsiderId);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("<strong>Rival Team</strong>");
    await expectNotFoundShell(await getRoute(`/teamorgmx/teams/${world.alphaTeamId}`, world.outsiderId));
    // And the AND-arm the fixture pins for the list: nadia's list never
    // carries the rival team (the org-scoped listTeams read).
    const list = await getRoute("/teamorgmx/teams", world.ownerId);
    expect(await list.text()).not.toContain("Rival Team");
  });
});
