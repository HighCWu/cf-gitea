/**
 * Route-level enforcement of the SPEC-0007 §3.5 team grant on repo-scoped
 * reads — the D1-bench finding (ef2c049): `canViewRepositoryWithTeams` was
 * predicate-complete (the service matrix in repository.test.ts) but had NO
 * route callers, so a read-team member got the anti-enumeration 404 on
 * GET /repos/{org}/{repo} while the git-HTTP gate (git-http/acl.ts) admitted
 * the same identity through the same predicate. The surfaces here ride the
 * real router: repoGet (the bench probe), repoListIssues, repoSearch's
 * SQL-level team arm — plus the byte-exact stranger/missing 404 parity pin.
 *
 * The bench-shaped fixture (org + `write` team + private repo + member, all
 * through the team APIs) mirrors scripts/bench-d1.mjs seedHttpFixtures, so
 * the bench's team phase measures the same production predicate these tests
 * pin.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repositories, teamMembers, teamRepoAccess, teams, users, type TeamAccessMode } from "../db/schema";
import { OrgService, type OrgRecord } from "../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../services/orgs/testing";
import type { User } from "./models/user";
import { createApiRouter } from "./router";

beforeAll(applyOrgsDdl);

beforeEach(async () => {
  // Issues-family rows reference repositories/users — sweep them BEFORE
  // resetOrgTables drops those tables' rows (the issues.test.ts order).
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "pull_requests",
    "comments",
    "issue_labels",
    "issues",
    "labels",
    "milestones",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ERROR_URL = "https://example.com/api/swagger";

/** Seeded D1 users the test resolver can authenticate as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

async function seedUser(username: string): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin: false });
  return { id: user.id, username: user.username };
}

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** API `User` projection the resolver returns (the org-repos.test.ts shape). */
function apiUser(user: { id: number; username: string; isAdmin: boolean }): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

const router = () => {
  const app = createApiRouter({
    auth: {
      resolveToken(token) {
        const match = /^u(\d+)$/.exec(token);
        const user = match === null ? undefined : seededUsers.get(Number(match[1]));
        if (match === null || user === undefined) return Promise.resolve(null);
        return Promise.resolve(apiUser(user));
      },
    },
  });
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

let repoSeq = 900;

/** Raw repositories row (visibility is what the predicate reads; the engine
 *  is not involved in any of these surfaces). */
async function seedRepo(
  ownerNamespace: string,
  ownerId: number,
  slug: string,
  visibility: "public" | "private",
): Promise<string> {
  const id = `tv${repoSeq++}`;
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  return id;
}

/** Team with one member, covering (or not) the given repo ids. */
async function seedTeam(
  org: OrgRecord,
  name: string,
  authorize: TeamAccessMode,
  userId: number,
  repoIds: string[],
  options: { includesAll?: boolean; unitsMap?: Record<string, string> } = {},
): Promise<number> {
  const inserted = await db()
    .insert(teams)
    .values({
      orgId: org.id,
      lowerName: name,
      name,
      authorize,
      includesAllRepositories: options.includesAll === true,
      unitsMap: options.unitsMap ? JSON.stringify(options.unitsMap) : null,
      visibility: "private",
    })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  await db().insert(teamMembers).values({ orgId: org.id, teamId, userId });
  for (const repoId of repoIds) {
    await db().insert(teamRepoAccess).values({ orgId: org.id, teamId, repoId });
  }
  return teamId;
}

/** Org `acme` (owner OrgOwner) + the private `vault` repo, resolved. */
async function seedOrgFixture(): Promise<{
  org: OrgRecord;
  owner: { id: number; username: string };
  repoId: string;
}> {
  const owner = await seedUser("OrgOwner");
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
  const repoId = await seedRepo(org.usernameLower, org.id, "vault", "private");
  return { org, owner, repoId };
}

describe("GET /repos/{owner}/{repo} — the bench-found gap (repoGet)", () => {
  it("a read-team member gets 200 with the granted permissions block", async () => {
    const { org, repoId } = await seedOrgFixture();
    const member = await seedUser("TeamMate");
    await seedTeam(org, "readers", "read", member.id, [repoId]);

    const res = await router()("/repos/acme/vault", { headers: authHeaders(member.id) });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.full_name).toBe("acme/vault");
    expect(body.private).toBe(true);
    // read ⇒ pull only (the embedded AccessMode mapping, upstream ToRepo).
    expect(body.permissions).toEqual({ admin: false, push: false, pull: true });
  });

  it("an includes-all team reaches the route without an explicit repo row", async () => {
    const { org } = await seedOrgFixture();
    const member = await seedUser("TeamMate");
    await seedTeam(org, "all", "read", member.id, [], { includesAll: true });

    const res = await router()("/repos/acme/vault", { headers: authHeaders(member.id) });
    expect(res.status).toBe(200);
  });

  it("a stranger gets the SAME 404 as a missing repo — signed or anonymous", async () => {
    await seedOrgFixture();
    const stranger = await seedUser("Outsider");

    const invisible = await router()("/repos/acme/vault", { headers: authHeaders(stranger.id) });
    const missing = await router()("/repos/acme/never-existed", { headers: authHeaders(stranger.id) });
    const anonymous = await router()("/repos/acme/vault");

    expect(invisible.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(anonymous.status).toBe(404);
    const invisibleBody = await invisible.json();
    // Anti-enumeration parity: invisible and missing are indistinguishable.
    expect(invisibleBody).toStrictEqual(await missing.json());
    expect(invisibleBody).toStrictEqual(await anonymous.json());
    expect(invisibleBody).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("the bench probe shape passes: org + write team + repo + member via the team APIs", async () => {
    // seedHttpFixtures' exact sequence (scripts/bench-d1.mjs): the untimed
    // member GET measured a 404 while the guard resolved the reduced ACL.
    const owner = await seedUser("BenchOwner");
    const member = await seedUser("BenchMember");
    const call = router();

    const org = await call("/orgs", {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ username: "benchorg" }),
    });
    expect(org.status).toBe(201);

    const repo = await call("/orgs/benchorg/repos", {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ name: "probe", private: true, auto_init: false }),
    });
    expect(repo.status).toBe(201);

    const team = await call("/orgs/benchorg/teams", {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ name: "write", permission: "write" }),
    });
    expect(team.status).toBe(201);
    const teamId = (await team.json<{ id: number }>()).id;

    expect((await call(`/teams/${teamId}/repos/benchorg/probe`, { method: "PUT", headers: authHeaders(owner.id) })).status).toBe(204);
    expect((await call(`/teams/${teamId}/members/BenchMember`, { method: "PUT", headers: authHeaders(owner.id) })).status).toBe(204);

    // The probe: 200 now, with the write team's push arm rendered.
    const probe = await call("/repos/benchorg/probe", { headers: authHeaders(member.id) });
    expect(probe.status).toBe(200);
    const body = await probe.json<Record<string, unknown>>();
    expect(body.permissions).toEqual({ admin: false, push: true, pull: true });
  });
});

describe("GET /repos/{owner}/{repo}/issues — the issues list family (repoListIssues)", () => {
  it("a team member lists the private repo's issues; a stranger gets the 404", async () => {
    const { org, owner, repoId } = await seedOrgFixture();
    // The org OWNER authors the issue through the route — the Owners-team
    // bridge arm admits them (their login never matches an org namespace).
    const created = await router()("/repos/acme/vault/issues", {
      method: "POST",
      headers: authHeaders(owner.id),
      body: JSON.stringify({ title: "team-visible" }),
    });
    expect(created.status).toBe(201);

    const member = await seedUser("TeamMate");
    await seedTeam(org, "readers", "read", member.id, [repoId]);

    const res = await router()("/repos/acme/vault/issues", { headers: authHeaders(member.id) });
    expect(res.status).toBe(200);
    const list = await res.json<Array<{ title: string }>>();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("team-visible");

    const stranger = await seedUser("Outsider");
    const denied = await router()("/repos/acme/vault/issues", { headers: authHeaders(stranger.id) });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/search — the SQL list arm of the team grant", () => {
  it("the grant widens the member's search; a stranger's and the anonymous search do not leak", async () => {
    const { org, repoId } = await seedOrgFixture();
    const member = await seedUser("TeamMate");
    const stranger = await seedUser("Outsider");
    await seedTeam(org, "readers", "read", member.id, [repoId]);

    const seen = await router()("/repos/search?q=vault", { headers: authHeaders(member.id) });
    expect(seen.status).toBe(200);
    const memberBody = await seen.json<{ ok: boolean; data: Array<{ full_name: string }> }>();
    expect(memberBody.ok).toBe(true);
    expect(memberBody.data.map((repo) => repo.full_name)).toContain("acme/vault");

    const strangerBody = await (
      await router()("/repos/search?q=vault", { headers: authHeaders(stranger.id) })
    ).json<{ data: unknown[] }>();
    expect(strangerBody.data).toEqual([]);

    const anonymousBody = await (await router()("/repos/search?q=vault")).json<{ data: unknown[] }>();
    expect(anonymousBody.data).toEqual([]);
  });

  it("covers includes-all teams and units-collapsed teams (the json_each arm)", async () => {
    const { org, repoId } = await seedOrgFixture();
    const allMember = await seedUser("AllMate");
    await seedTeam(org, "all", "read", allMember.id, [], { includesAll: true });
    const unitsMember = await seedUser("UnitsMate");
    // authorize 'none' with a units_map write — effective write through the
    // unit collapse (OrgService.teamRepoAccessMode's row-wise rule, mirrored
    // by the list EXISTS).
    await seedTeam(org, "units", "none", unitsMember.id, [repoId], { unitsMap: { "repo.code": "write" } });

    for (const user of [allMember, unitsMember]) {
      const res = await router()("/repos/search?q=vault", { headers: authHeaders(user.id) });
      const body = await res.json<{ data: Array<{ full_name: string }> }>();
      expect(body.data.map((repo) => repo.full_name)).toContain("acme/vault");
    }
  });
});
