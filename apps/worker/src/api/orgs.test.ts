/**
 * Tier-2 organization routes on real D1 (SPEC-0004 appendix A category a):
 * `GET/PATCH/DELETE /orgs/{org}` (orgGet/orgEdit/orgDelete), `POST
 * /orgs/{org}/rename` (renameOrg), `GET /orgs` (orgGetAll), `POST /orgs`
 * (orgCreate), `GET /users/{username}/orgs` (orgListUserOrgs), `GET
 * /users/{username}/orgs/{org}/permissions` (orgGetUserPermissions), the
 * members family (orgListMembers/orgIsMember/orgDeleteMember) and the
 * public-members family (orgListPublicMembers/orgIsPublicMember/
 * orgPublicizeMember/orgConcealMember). Orgs seed through the landed
 * OrgService (org-as-user-row model, SPEC-0007) and memberships through its
 * addMember/setMemberRole primitives; the wire shapes assert against the
 * frozen contract — including the mirrored upstream quirks: the anonymous
 * email blank on GET /orgs/{org} (and its ABSENCE on the GET /orgs listing),
 * the members listing's reqToken 401 (the swagger declares only 200/404),
 * the 303 oracle redirect on GET /orgs/{org}/members/{username}, the
 * silent-204 member delete, the 500 last-owner guard, the 500 org-owns-repos
 * guard, the admin's all-members view of public_members, the visibility
 * ladders of the two listings, the rename 422s + redirect seam, and the
 * renamed-org 307 seam.
 *
 * Bootstrap: `applyOrgsDdl()` (src/services/orgs/testing.ts — the generated
 * migrations) + `resetOrgTables()`. The routes are mounted on a local
 * OpenAPIHono with the REAL auth middlewares (the same pair the orchestrator's
 * `registerOrgProfileRoutes(app, requireAuth, optionalAuth)` one-liner will
 * pass), so the doer identity and the org_members rows refer to the same D1
 * rows.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import type { User } from "./models/user";
import { registerOrgProfileRoutes } from "./routes/orgs";
import { RepoService } from "../repos/service";
import { OrgService } from "../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../services/orgs/testing";
import contract from "../compat/contract/v1-swagger.generated.json";

beforeAll(applyOrgsDdl);

beforeEach(async () => {
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ORGANIZATION_FIELDS = Object.keys(contract.definitions.Organization.properties).sort();
const ORGANIZATION_PERMISSIONS_FIELDS = Object.keys(
  contract.definitions.OrganizationPermissions.properties,
).sort();
const USER_FIELDS = Object.keys(contract.definitions.User.properties);
const ERROR_URL = "https://example.com/api/swagger";

/** Seeded D1 users the test resolver can authenticate as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

interface SeededUser {
  id: number;
  username: string;
}

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username };
}

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** API `User` projection the resolver returns (the auth middleware's shape). */
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

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

/** Local mount of exactly the orchestrator one-liner's seam. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerOrgProfileRoutes(
    app,
    createTokenAuthMiddleware(resolver),
    createOptionalTokenAuthMiddleware(resolver),
  );
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface OrgSeed {
  orgId: number;
  owner: SeededUser;
  member: SeededUser;
  publicMember: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
}

/** The standard org: owner + a concealed member + a public member + an
 *  outsider + a site admin. */
async function seedOrg(options: { visibility?: "public" | "limited" | "private"; name?: string } = {}): Promise<OrgSeed> {
  const owner = await seedUser("org-owner");
  const member = await seedUser("plain-member");
  const publicMember = await seedUser("loud-member");
  const outsider = await seedUser("outsider");
  const admin = await seedUser("site-admin", true);
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({
    name: options.name ?? "acme",
    ownerId: owner.id,
    visibility: options.visibility ?? "public",
    fullName: "Acme Rockets",
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await orgs.addMember(org.id, member.id);
  await orgs.addMember(org.id, publicMember.id, { isPublic: true });
  return { orgId: org.id, owner, member, publicMember, outsider, admin };
}

// ---------------------------------------------------------------------------
// GET /orgs/{org} (orgGet)
// ---------------------------------------------------------------------------

describe("GET /orgs/{org} (orgGet)", () => {
  it("serves the 11-field Organization projection to an anonymous caller with the email blanked", async () => {
    await seedOrg();
    const response = await router()("/orgs/acme");
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body).sort()).toEqual(ORGANIZATION_FIELDS);
    expect(body.name).toBe("acme");
    expect(body.username).toBe("acme"); // deprecated alias, kept faithful
    expect(body.full_name).toBe("Acme Rockets");
    expect(body.visibility).toBe("public");
    expect(body.email).toBe(""); // Don't show Mail, when User is not logged in
    expect(body.repo_admin_change_team_access).toBe(false);
  });

  it("shows the email to an authenticated caller and blanks it for anonymous ones", async () => {
    const seed = await seedOrg();
    const send = router();
    // The org's email is only ever set through the edit path (create leaves
    // it null — rendered as the empty string either way).
    const edited = await send("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ email: "crew@acme.example" }),
    });
    expect(edited.status).toBe(200);
    const authed = await send("/orgs/acme", { headers: authHeaders(seed.outsider.id) });
    const authedBody: { email: string } = await authed.json();
    expect(authedBody.email).toBe("crew@acme.example");
    const anonymous = await send("/orgs/acme");
    const anonymousBody: { email: string } = await anonymous.json();
    expect(anonymousBody.email).toBe(""); // Don't show Mail, when User is not logged in
  });

  it("404s a missing org and a plain user alike (the §4.11 type gate)", async () => {
    await seedUser("plain-human");
    const send = router();
    const missing = await send("/orgs/ghost");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
    const user = await send("/orgs/plain-human");
    expect(user.status).toBe(404);
  });

  it("404s limited/private orgs for anonymous and non-member callers; members and admins get through", async () => {
    const seed = await seedOrg({ visibility: "private" });
    const send = router();
    expect((await send("/orgs/acme")).status).toBe(404);
    expect((await send("/orgs/acme", { headers: authHeaders(seed.outsider.id) })).status).toBe(404);
    expect((await send("/orgs/acme", { headers: authHeaders(seed.member.id) })).status).toBe(200);
    expect((await send("/orgs/acme", { headers: authHeaders(seed.admin.id) })).status).toBe(200);
  });

  it("307s a renamed org before any visibility work, path+query preserved (the redirect seam)", async () => {
    const seed = await seedOrg();
    const orgs = new OrgService(env.DB);
    await orgs.renameOrg(seed.orgId, "acme-industries");
    const response = await router()("/orgs/acme?page=2");
    expect(response.status).toBe(307);
    // RedirectToUser replaces the first occurrence of the old name in the
    // REQUEST path (upstream's path carries the /api/v1 mount; the local
    // router sees the bare path) and preserves the query.
    expect(response.headers.get("Location")).toBe("/orgs/acme-industries?page=2");
  });

  it("404s the renamed private org for anonymous callers (the RedirectToUser gate)", async () => {
    const seed = await seedOrg({ visibility: "private" });
    const orgs = new OrgService(env.DB);
    await orgs.renameOrg(seed.orgId, "acme-industries");
    expect((await router()("/orgs/acme")).status).toBe(404);
    // Signed-in outsiders pass the coarse redirect gate (it has no membership
    // arm — context_response.go:40-47 only asks for a signed-in,
    // non-public-only doer) and receive the 307; the 404 comes from the
    // HANDLER's HasOrgOrUserVisible AFTER following it.
    const response = await router()("/orgs/acme", { headers: authHeaders(seed.outsider.id) });
    expect(response.status).toBe(307);
  });
});

// ---------------------------------------------------------------------------
// PATCH /orgs/{org} (orgEdit)
// ---------------------------------------------------------------------------

describe("PATCH /orgs/{org} (orgEdit)", () => {
  it("applies only the presented fields and answers the edited Organization", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ full_name: "Acme Rockets Inc.", location: "Luna", description: "to the moon" }),
    });
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body).sort()).toEqual(ORGANIZATION_FIELDS);
    expect(body.full_name).toBe("Acme Rockets Inc.");
    expect(body.location).toBe("Luna");
    expect(body.description).toBe("to the moon");
    // untouched fields keep their values
    expect(body.website).toBe("");

    const org = await new OrgService(env.DB).getOrgByUsername("acme");
    expect(org?.fullName).toBe("Acme Rockets Inc.");
    expect(org?.visibility).toBe("public");
  });

  it("clears a field with an empty string and flips visibility + the team-access flag", async () => {
    const seed = await seedOrg();
    const send = router();
    const first = await send("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ description: "temporary" }),
    });
    expect(first.status).toBe(200);
    const second = await send("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ description: "", visibility: "limited", repo_admin_change_team_access: true }),
    });
    expect(second.status).toBe(200);
    const body: Record<string, unknown> = await second.json();
    expect(body.description).toBe("");
    expect(body.visibility).toBe("limited");
    expect(body.repo_admin_change_team_access).toBe(true);
    // the §4.8 flip is immediately effective on the read paths: a limited org
    // 404s for anonymous GET /orgs/{org} (unlike the repos listing's §4.7
    // quirk) while the owner still gets through.
    expect((await send("/orgs/acme")).status).toBe(404);
    expect((await send("/orgs/acme", { headers: authHeaders(seed.owner.id) })).status).toBe(200);
  });

  it("403s non-owner members with the exact upstream message, 401s anonymous, 404s missing orgs", async () => {
    const seed = await seedOrg();
    const send = router();
    const forbidden = await send("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.member.id),
      body: JSON.stringify({ full_name: "hijacked" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });
    const anonymous = await send("/orgs/acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: "x" }),
    });
    expect(anonymous.status).toBe(401);
    expect((await send("/orgs/ghost", { method: "PATCH", headers: authHeaders(seed.owner.id), body: "{}" })).status).toBe(
      404,
    );
  });

  it("edits through the renamed name only after following the 307 (upstream redirects before auth)", async () => {
    const seed = await seedOrg();
    const orgs = new OrgService(env.DB);
    await orgs.renameOrg(seed.orgId, "acme-industries");
    // The old name answers the seam, not the edit.
    const redirected = await router()("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ full_name: "post-rename" }),
    });
    expect(redirected.status).toBe(307);
    // The new name edits.
    const edited = await router()("/orgs/acme-industries", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ full_name: "post-rename" }),
    });
    expect(edited.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /orgs/{org}/members (orgListMembers)
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/members (orgListMembers)", () => {
  it("lists every member (hidden ones included) for an org member, ordered by uid", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme/members", { headers: authHeaders(seed.owner.id) });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    for (const entry of body) {
      expect(Object.keys(entry).every((key) => USER_FIELDS.includes(key))).toBe(true);
    }
    expect(body.map((entry) => entry.login)).toEqual(["org-owner", "plain-member", "loud-member"]);
    expect(response.headers.get("X-Total-Count")).toBe("3");
  });

  it("lists only public members for a signed-in outsider and paginates", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme/members?limit=1", { headers: authHeaders(seed.outsider.id) });
    expect(response.status).toBe(200);
    const body: Array<{ login: string }> = await response.json();
    expect(body.map((entry) => entry.login)).toEqual(["loud-member"]);
    expect(response.headers.get("X-Total-Count")).toBe("1");
    const link = response.headers.get("Link") ?? "";
    expect(link).toBe(""); // a single-row result spans no pages
  });

  it("gives site admins the full list (DoerIsSiteAdminFullAccess disables PublicOnly)", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme/members", { headers: authHeaders(seed.admin.id) });
    expect(response.status).toBe(200);
    const body: Array<{ login: string }> = await response.json();
    expect(body).toHaveLength(3);
  });

  it("401s anonymous callers (runtime-only; upstream reqToken) and 404s missing orgs", async () => {
    await seedOrg();
    const send = router();
    const anonymous = await send("/orgs/acme/members");
    expect(anonymous.status).toBe(401);
    expect((await send("/orgs/acme/members", { headers: authHeaders((await seedUser("anyone")).id) })).status).toBe(200);
    expect((await send("/orgs/ghost/members", { headers: authHeaders((await seedUser("anyone2")).id) })).status).toBe(
      404,
    );
  });

  it("404s an invisible org's members for outsiders (reqOrgVisible)", async () => {
    const seed = await seedOrg({ visibility: "private" });
    const response = await router()("/orgs/acme/members", { headers: authHeaders(seed.outsider.id) });
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /orgs/{org}/members/{username} (orgIsMember)
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/members/{username} (orgIsMember)", () => {
  it("204s a member and 404s a non-member for an org member's eyes", async () => {
    const seed = await seedOrg();
    const send = router();
    expect(
      (await send(`/orgs/acme/members/${seed.member.username}`, { headers: authHeaders(seed.owner.id) })).status,
    ).toBe(204);
    expect(
      (await send(`/orgs/acme/members/${seed.outsider.username}`, { headers: authHeaders(seed.owner.id) })).status,
    ).toBe(404);
  });

  it("404s a signed-in non-member checking themself, and 303s them checking others", async () => {
    const seed = await seedOrg();
    const send = router();
    const self = await send(`/orgs/acme/members/${seed.outsider.username}`, {
      headers: authHeaders(seed.outsider.id),
    });
    expect(self.status).toBe(404);
    const other = await send(`/orgs/acme/members/${seed.owner.username}`, { headers: authHeaders(seed.outsider.id) });
    expect(other.status).toBe(303);
    expect(other.headers.get("Location")).toBe(
      `/api/v1/orgs/acme/public_members/${seed.owner.username}`,
    );
  });

  it("401s anonymous callers (runtime-only) and 404s missing targets", async () => {
    const seed = await seedOrg();
    const send = router();
    expect((await send("/orgs/acme/members/ghost-user")).status).toBe(401);
    expect(
      (await send("/orgs/acme/members/ghost-user", { headers: authHeaders(seed.owner.id) })).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /orgs/{org}/members/{username} (orgDeleteMember)
// ---------------------------------------------------------------------------

describe("DELETE /orgs/{org}/members/{username} (orgDeleteMember)", () => {
  it("removes a member (204), deletes the row, and maintains num_members", async () => {
    const seed = await seedOrg();
    const response = await router()(`/orgs/acme/members/${seed.member.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const org = await new OrgService(env.DB).getOrgById(seed.orgId);
    expect(org?.numMembers).toBe(2);
    const membership = await new OrgService(env.DB).getMembership(seed.orgId, seed.member.id);
    expect(membership).toBeNull();
  });

  it("silently 204s a non-member target (upstream RemoveOrgUser returns nil)", async () => {
    const seed = await seedOrg();
    const response = await router()(`/orgs/acme/members/${seed.outsider.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(204);
    const org = await new OrgService(env.DB).getOrgById(seed.orgId);
    expect(org?.numMembers).toBe(3);
  });

  it("403s non-owners with the exact upstream message", async () => {
    const seed = await seedOrg();
    const response = await router()(`/orgs/acme/members/${seed.publicMember.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.member.id),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });
  });

  it("500s the last-owner removal through the blank APIErrorInternal body (§4.3)", async () => {
    const seed = await seedOrg();
    // Demote everyone but the owner, then remove the owner themself.
    const orgs = new OrgService(env.DB);
    await orgs.removeMember(seed.orgId, seed.member.id);
    await orgs.removeMember(seed.orgId, seed.publicMember.id);
    const response = await router()(`/orgs/acme/members/${seed.owner.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(500);
    // APIErrorInternal blanks the message in prod for non-admins — the
    // unmapped OrgError lands in giteaErrorHandler's default branch.
    expect(await response.json()).toEqual({ message: "", url: ERROR_URL });
  });
});

// ---------------------------------------------------------------------------
// GET /orgs/{org}/public_members (orgListPublicMembers)
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/public_members (orgListPublicMembers)", () => {
  it("lists only is_public rows for anonymous and plain signed-in callers", async () => {
    const seed = await seedOrg();
    const send = router();
    for (const init of [undefined, { headers: authHeaders(seed.outsider.id) }] as const) {
      const response = await send("/orgs/acme/public_members", init);
      expect(response.status).toBe(200);
      const body: Array<{ login: string }> = await response.json();
      expect(body.map((entry) => entry.login)).toEqual(["loud-member"]);
      expect(response.headers.get("X-Total-Count")).toBe("1");
    }
  });

  it("shows the admin every member (the mirrored upstream quirk)", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme/public_members", { headers: authHeaders(seed.admin.id) });
    expect(response.status).toBe(200);
    const body: Array<{ login: string }> = await response.json();
    expect(body).toHaveLength(3);
  });

  it("404s missing orgs", async () => {
    await seedOrg();
    expect((await router()("/orgs/ghost/public_members")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET/PUT/DELETE /orgs/{org}/public_members/{username}
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/public_members/{username} (orgIsPublicMember)", () => {
  it("204s public members and 404s concealed members, non-members, and missing targets", async () => {
    const seed = await seedOrg();
    const send = router();
    expect((await send(`/orgs/acme/public_members/${seed.publicMember.username}`)).status).toBe(204);
    expect((await send(`/orgs/acme/public_members/${seed.member.username}`)).status).toBe(404);
    expect((await send(`/orgs/acme/public_members/${seed.outsider.username}`)).status).toBe(404);
    expect((await send("/orgs/acme/public_members/ghost-user")).status).toBe(404);
  });
});

describe("PUT/DELETE /orgs/{org}/public_members/{username} (orgPublicizeMember/orgConcealMember)", () => {
  it("lets a member publicize themself (204) and appear in the public listing", async () => {
    const seed = await seedOrg();
    const send = router();
    const response = await send(`/orgs/acme/public_members/${seed.member.username}`, {
      method: "PUT",
      headers: authHeaders(seed.member.id),
    });
    expect(response.status).toBe(204);
    expect((await send(`/orgs/acme/public_members/${seed.member.username}`)).status).toBe(204);
    const listing = await send("/orgs/acme/public_members");
    const listingBody: Array<{ login: string }> = await listing.json();
    expect(
      listingBody
        .map((entry) => entry.login)
        .sort()
        .join(","),
    ).toBe("loud-member,plain-member");
  });

  it("lets an owner publicize a member, and 403s a member touching someone else", async () => {
    const seed = await seedOrg();
    const send = router();
    const byOwner = await send(`/orgs/acme/public_members/${seed.member.username}`, {
      method: "PUT",
      headers: authHeaders(seed.owner.id),
    });
    expect(byOwner.status).toBe(204);
    const byMember = await send(`/orgs/acme/public_members/${seed.publicMember.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.member.id),
    });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toEqual({ message: "Cannot change member visibility", url: ERROR_URL });
  });

  it("403s non-members with the exact upstream message and 401s anonymous callers", async () => {
    const seed = await seedOrg();
    const send = router();
    const outsiderFlip = await send(`/orgs/acme/public_members/${seed.member.username}`, {
      method: "PUT",
      headers: authHeaders(seed.outsider.id),
    });
    expect(outsiderFlip.status).toBe(403);
    expect(await outsiderFlip.json()).toEqual({ message: "Must be an organization member", url: ERROR_URL });
    expect(
      (await send(`/orgs/acme/public_members/${seed.member.username}`, { method: "PUT" })).status,
    ).toBe(401);
  });

  it("no-ops (204) for a non-member target — ChangeOrgUserStatus's silent miss", async () => {
    const seed = await seedOrg();
    const send = router();
    const response = await send(`/orgs/acme/public_members/${seed.outsider.username}`, {
      method: "PUT",
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(204);
    expect((await send(`/orgs/acme/public_members/${seed.outsider.username}`)).status).toBe(404);
  });

  it("conceals a public membership (204) and drops the row from the public listing", async () => {
    const seed = await seedOrg();
    const send = router();
    const response = await send(`/orgs/acme/public_members/${seed.publicMember.username}`, {
      method: "DELETE",
      headers: authHeaders(seed.publicMember.id),
    });
    expect(response.status).toBe(204);
    expect((await send(`/orgs/acme/public_members/${seed.publicMember.username}`)).status).toBe(404);
    // The membership itself survives the concealment.
    expect(
      (await send(`/orgs/acme/members/${seed.publicMember.username}`, { headers: authHeaders(seed.owner.id) })).status,
    ).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// GET /orgs (orgGetAll)
// ---------------------------------------------------------------------------

/** Four orgs spanning the visibility ladder, named for the alphabetical
 *  order assertions (lower_name ASC, the SearchOrderByAlphabetically port). */
async function seedOrgLadder(): Promise<{ owner: SeededUser; outsider: SeededUser; admin: SeededUser }> {
  const owner = await seedUser("ladder-owner");
  const outsider = await seedUser("ladder-outsider");
  const admin = await seedUser("ladder-admin", true);
  const orgs = new OrgService(env.DB);
  await orgs.createOrg({ name: "acme", ownerId: owner.id });
  await orgs.createOrg({ name: "zenith", ownerId: owner.id });
  await orgs.createOrg({ name: "limco", ownerId: owner.id, visibility: "limited" });
  await orgs.createOrg({ name: "darkco", ownerId: owner.id, visibility: "private" });
  return { owner, outsider, admin };
}

describe("GET /orgs (orgGetAll)", () => {
  it("lists public orgs alphabetically for anonymous callers in the contract Organization shape", async () => {
    await seedOrgLadder();
    const response = await router()("/orgs");
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body.map((org) => org.name)).toEqual(["acme", "zenith"]);
    for (const entry of body) {
      expect(Object.keys(entry).sort()).toEqual(ORGANIZATION_FIELDS);
    }
    expect(response.headers.get("X-Total-Count")).toBe("2");
  });

  it("widens the Visible ladder: signed-in callers add limited orgs, admins add private ones", async () => {
    const seed = await seedOrgLadder();
    const send = router();
    const authed: Array<{ name?: unknown }> = await (
      await send("/orgs", { headers: authHeaders(seed.outsider.id) })
    ).json();
    expect(authed.map((org) => org.name)).toEqual(["acme", "limco", "zenith"]);
    const adminView: Array<{ name?: unknown }> = await (
      await send("/orgs", { headers: authHeaders(seed.admin.id) })
    ).json();
    expect(adminView.map((org) => org.name)).toEqual(["acme", "darkco", "limco", "zenith"]);
  });

  it("does NOT blank the org email — GetAll renders ToOrganization verbatim, unlike Get", async () => {
    const seed = await seedOrgLadder();
    const send = router();
    await send("/orgs/acme", {
      method: "PATCH",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ email: "crew@acme.example" }),
    });
    const body: Array<{ name?: string; email?: string }> = await (await send("/orgs")).json();
    expect(body.find((org) => org.name === "acme")?.email).toBe("crew@acme.example");
  });

  it("paginates with the runtime headers (limit=1, full total)", async () => {
    await seedOrgLadder();
    const response = await router()("/orgs?limit=1");
    expect(response.status).toBe(200);
    const body: Array<unknown> = await response.json();
    expect(body).toHaveLength(1);
    expect(response.headers.get("X-Total-Count")).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// POST /orgs (orgCreate)
// ---------------------------------------------------------------------------

describe("POST /orgs (orgCreate)", () => {
  it("creates the org (201, contract Organization shape) and installs the creator as owner", async () => {
    const creator = await seedUser("bravo-creator");
    const response = await router()("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "bravo" }),
    });
    expect(response.status).toBe(201);
    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body).sort()).toEqual(ORGANIZATION_FIELDS);
    expect(body.name).toBe("bravo");
    expect(body.visibility).toBe("public");
    const orgs = new OrgService(env.DB);
    const org = await orgs.getOrgByUsername("bravo");
    expect(org?.numMembers).toBe(1);
    expect((await orgs.getMembership(org!.id, creator.id))?.role).toBe("owner");
  });

  it("honors the optional profile fields, visibility, and the team-access flag", async () => {
    const creator = await seedUser("charlie-creator");
    const response = await router()("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({
        username: "charlie",
        full_name: "Charlie Co",
        description: "chocolate",
        website: "https://charlie.example",
        location: "Lucerna",
        email: "hi@charlie.example",
        visibility: "limited",
        repo_admin_change_team_access: true,
      }),
    });
    expect(response.status).toBe(201);
    const org = await new OrgService(env.DB).getOrgByUsername("charlie");
    expect(org?.visibility).toBe("limited");
    expect(org?.fullName).toBe("Charlie Co");
    expect(org?.description).toBe("chocolate");
    expect(org?.website).toBe("https://charlie.example");
    expect(org?.location).toBe("Lucerna");
    expect(org?.email).toBe("hi@charlie.example");
    expect(org?.repoAdminChangeTeamAccess).toBe(true);
    // the limited org reads as a miss for anonymous GET /orgs/{org}…
    expect((await router()("/orgs/charlie")).status).toBe(404);
    // …but surfaces on the authed GET /orgs listing (the ladder).
    const listing: Array<{ name?: string }> = await (
      await router()("/orgs", { headers: authHeaders(creator.id) })
    ).json();
    expect(listing.some((org) => org.name === "charlie")).toBe(true);
  });

  it("422s a name colliding with an existing org or user, upstream message verbatim", async () => {
    const creator = await seedUser("delta-creator");
    await seedUser("delta-user");
    const send = router();
    const first = await send("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "delta" }),
    });
    expect(first.status).toBe(201);
    const again = await send("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "delta" }),
    });
    expect(again.status).toBe(422);
    expect(await again.json()).toEqual({ message: "user already exists [name: delta]", url: ERROR_URL });
    // the shared user/org namespace: an existing plain user blocks it too
    const userCollision = await send("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "delta-user" }),
    });
    expect(userCollision.status).toBe(422);
    expect(await userCollision.json()).toEqual({ message: "user already exists [name: delta-user]", url: ERROR_URL });
  });

  it("422s reserved, invalid, and oversized names with the ported errclass messages", async () => {
    const creator = await seedUser("echo-creator");
    const send = router();
    const reserved = await send("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "org" }),
    });
    expect(reserved.status).toBe(422);
    expect(await reserved.json()).toEqual({ message: "name is reserved [name: org]", url: ERROR_URL });
    const invalid = await send("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "a b" }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      message: "name is invalid [a b]: must be valid alpha or numeric or dash(-_) or dot characters",
      url: ERROR_URL,
    });
    const oversized = await send("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "x".repeat(41) }),
    });
    expect(oversized.status).toBe(422);
    expect(await oversized.json()).toEqual({
      message: `username is too long [name: ${"x".repeat(41)}] (max 40)`,
      url: ERROR_URL,
    });
  });

  it("consumes a user_redirect squatting the name (create-over-redirect)", async () => {
    const creator = await seedUser("foxtrot-creator");
    const orgs = new OrgService(env.DB);
    const first = await orgs.createOrg({ name: "foxtrot", ownerId: creator.id });
    await orgs.renameOrg(first.id, "foxtrot-two");
    const response = await router()("/orgs", {
      method: "POST",
      headers: authHeaders(creator.id),
      body: JSON.stringify({ username: "foxtrot" }),
    });
    expect(response.status).toBe(201);
    // the old name now resolves DIRECTLY to the new org — no 307
    expect((await router()("/orgs/foxtrot")).status).toBe(200);
  });

  it("401s anonymous callers (runtime-only; reqToken upstream)", async () => {
    await seedUser("golf-creator");
    const response = await router()("/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "golf" }),
    });
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/orgs (orgListUserOrgs)
// ---------------------------------------------------------------------------

/** owner owns pubco (public) / limco (limited) / privco (private); member
 *  joined pubco CONCEALED and limco publicized — the is_public filter's two
 *  arms under every ceiling. */
async function seedUserOrgs(): Promise<{
  owner: SeededUser;
  member: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
}> {
  const owner = await seedUser("list-owner");
  const member = await seedUser("list-member");
  const outsider = await seedUser("list-outsider");
  const admin = await seedUser("list-admin", true);
  const orgs = new OrgService(env.DB);
  const pub = await orgs.createOrg({ name: "pubco", ownerId: owner.id });
  const lim = await orgs.createOrg({ name: "limco", ownerId: owner.id, visibility: "limited" });
  await orgs.createOrg({ name: "privco", ownerId: owner.id, visibility: "private" });
  await orgs.addMember(pub.id, member.id, { isPublic: false });
  await orgs.addMember(lim.id, member.id, { isPublic: true });
  return { owner, member, outsider, admin };
}

describe("GET /users/{username}/orgs (orgListUserOrgs)", () => {
  it("self-lists every membership, concealed ones included (the private ceiling skips is_public)", async () => {
    const seed = await seedUserOrgs();
    const response = await router()(`/users/${seed.member.username}/orgs`, {
      headers: authHeaders(seed.member.id),
    });
    expect(response.status).toBe(200);
    const body: Array<{ name?: string }> = await response.json();
    expect(body.map((org) => org.name)).toEqual(["limco", "pubco"]);
    expect(response.headers.get("X-Total-Count")).toBe("2");
  });

  it("gives a signed-in outsider the limited ceiling: limited+public orgs, public memberships only", async () => {
    const seed = await seedUserOrgs();
    const response = await router()(`/users/${seed.member.username}/orgs`, {
      headers: authHeaders(seed.outsider.id),
    });
    expect(response.status).toBe(200);
    const body: Array<{ name?: string }> = await response.json();
    // pubco is public but the membership is concealed; limco passes both arms
    expect(body.map((org) => org.name)).toEqual(["limco"]);
  });

  it("401s anonymous callers (reqToken upstream) — the public ceiling is the public-only-token downgrade", async () => {
    const seed = await seedUserOrgs();
    const response = await router()(`/users/${seed.member.username}/orgs`);
    expect(response.status).toBe(401);
  });

  it("gives site admins the private ceiling over another principal's list", async () => {
    const seed = await seedUserOrgs();
    const adminView: Array<{ name?: string }> = await (
      await router()(`/users/${seed.member.username}/orgs`, { headers: authHeaders(seed.admin.id) })
    ).json();
    expect(adminView.map((org) => org.name)).toEqual(["limco", "pubco"]);
    const ownerAdminView: Array<{ name?: string }> = await (
      await router()(`/users/${seed.owner.username}/orgs`, { headers: authHeaders(seed.admin.id) })
    ).json();
    expect(ownerAdminView.map((org) => org.name)).toEqual(["limco", "privco", "pubco"]);
  });

  it("404s a missing subject with the shared error body", async () => {
    const seed = await seedUserOrgs();
    const missing = await router()("/users/ghost-user/orgs", { headers: authHeaders(seed.outsider.id) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
    expect((await router()("/users/ghost-user/orgs")).status).toBe(401);
  });

  it("200s an empty list for a subject with no memberships and for an org subject (type-blind quirk)", async () => {
    const seed = await seedUserOrgs();
    const bare = await seedUser("bare-human");
    const bareBody: Array<unknown> = await (
      await router()(`/users/${bare.username}/orgs`, { headers: authHeaders(seed.outsider.id) })
    ).json();
    expect(bareBody).toEqual([]);
    const orgSubject: Array<unknown> = await (
      await router()("/users/pubco/orgs", { headers: authHeaders(seed.outsider.id) })
    ).json();
    expect(orgSubject).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /orgs/{org}/rename (renameOrg)
// ---------------------------------------------------------------------------

describe("POST /orgs/{org}/rename (renameOrg)", () => {
  it("renames (204, empty body); the old name 307s to the new one", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme/rename", {
      method: "POST",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ new_name: "acme-corp" }),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const redirected = await router()("/orgs/acme");
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("Location")).toBe("/orgs/acme-corp");
    expect((await router()("/orgs/acme-corp")).status).toBe(200);
  });

  it("applies a case-only rename to the display case without writing a redirect", async () => {
    const seed = await seedOrg();
    const response = await router()("/orgs/acme/rename", {
      method: "POST",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ new_name: "ACME" }),
    });
    expect(response.status).toBe(204);
    const org = await new OrgService(env.DB).getOrgByUsername("acme");
    expect(org?.username).toBe("ACME");
    // same lower name — the lookup still hits, no 307 seam involved
    expect((await router()("/orgs/acme")).status).toBe(200);
  });

  it("403s non-owners with the exact message, 401s anonymous, 404s missing orgs", async () => {
    const seed = await seedOrg();
    const send = router();
    const forbidden = await send("/orgs/acme/rename", {
      method: "POST",
      headers: authHeaders(seed.member.id),
      body: JSON.stringify({ new_name: "hijacked" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });
    const anonymous = await send("/orgs/acme/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "hijacked" }),
    });
    expect(anonymous.status).toBe(401);
    const missing = await send("/orgs/ghost/rename", {
      method: "POST",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ new_name: "somewhere" }),
    });
    expect(missing.status).toBe(404);
  });

  it("422s collisions and reserved names with the upstream messages", async () => {
    const seed = await seedOrg();
    // a second org through the service (seedOrg's fixed user names collide)
    const rivalOwner = await seedUser("zenith-owner");
    await new OrgService(env.DB).createOrg({ name: "zenith", ownerId: rivalOwner.id });
    const send = router();
    const collision = await send("/orgs/acme/rename", {
      method: "POST",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ new_name: "zenith" }),
    });
    expect(collision.status).toBe(422);
    expect(await collision.json()).toEqual({ message: "user already exists [name: zenith]", url: ERROR_URL });
    const reserved = await send("/orgs/acme/rename", {
      method: "POST",
      headers: authHeaders(seed.owner.id),
      body: JSON.stringify({ new_name: "org" }),
    });
    expect(reserved.status).toBe(422);
    expect(await reserved.json()).toEqual({ message: "name is reserved [name: org]", url: ERROR_URL });
  });
});

// ---------------------------------------------------------------------------
// DELETE /orgs/{org} (orgDelete)
// ---------------------------------------------------------------------------

describe("DELETE /orgs/{org} (orgDelete)", () => {
  it("deletes an empty org (204): the org row, memberships, and redirect rows all go", async () => {
    const seed = await seedOrg();
    const orgs = new OrgService(env.DB);
    await orgs.renameOrg(seed.orgId, "acme-two"); // live redirect old→org at delete time
    const response = await router()("/orgs/acme-two", {
      method: "DELETE",
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await orgs.getOrgById(seed.orgId)).toBeNull();
    expect(await orgs.getMembership(seed.orgId, seed.member.id)).toBeNull();
    // the redirect row is gone — the old name reads as a plain 404, not a 307
    expect((await router()("/orgs/acme")).status).toBe(404);
    expect((await router()("/orgs/acme-two")).status).toBe(404);
  });

  it("500s through the blanked internal body while the org owns repositories", async () => {
    const seed = await seedOrg();
    await new RepoService(env.DB).create({
      owner: { id: seed.orgId, usernameLower: "acme" },
      name: "owned",
    });
    const response = await router()("/orgs/acme", {
      method: "DELETE",
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(500);
    // APIErrorInternal blanks the message — ErrUserOwnRepos rides the same seam
    expect(await response.json()).toEqual({ message: "", url: ERROR_URL });
    // and the org survives
    expect((await router()("/orgs/acme")).status).toBe(200);
  });

  it("403s non-owners with the exact message, 401s anonymous, 404s missing orgs", async () => {
    const seed = await seedOrg();
    const send = router();
    const forbidden = await send("/orgs/acme", { method: "DELETE", headers: authHeaders(seed.member.id) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "Must be an organization owner", url: ERROR_URL });
    expect((await send("/orgs/acme", { method: "DELETE" })).status).toBe(401);
    expect((await send("/orgs/ghost", { method: "DELETE", headers: authHeaders(seed.owner.id) })).status).toBe(404);
  });

  it("307s a renamed org before any ownership work (the group seam answers first)", async () => {
    const seed = await seedOrg();
    await new OrgService(env.DB).renameOrg(seed.orgId, "acme-two");
    // even the NON-OWNER member receives the redirect — it precedes reqToken
    const response = await router()("/orgs/acme", {
      method: "DELETE",
      headers: authHeaders(seed.member.id),
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/orgs/acme-two");
  });
});

// ---------------------------------------------------------------------------
// GET /users/{username}/orgs/{org}/permissions (orgGetUserPermissions)
// ---------------------------------------------------------------------------

describe("GET /users/{username}/orgs/{org}/permissions (orgGetUserPermissions)", () => {
  it("answers the all-true block for the org owner subject", async () => {
    const seed = await seedOrg();
    const response = await router()(`/users/${seed.owner.username}/orgs/acme/permissions`, {
      headers: authHeaders(seed.owner.id),
    });
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body).sort()).toEqual(ORGANIZATION_PERMISSIONS_FIELDS);
    expect(body).toEqual({
      can_read: true,
      can_write: true,
      is_admin: true,
      is_owner: true,
      can_create_repository: true,
    });
  });

  it("answers all-false for a plain member and a non-member subject (no teams modeled ⇒ authorize 0)", async () => {
    const seed = await seedOrg();
    const send = router();
    for (const subject of [seed.member, seed.outsider]) {
      const body: Record<string, boolean> = await (
        await send(`/users/${subject.username}/orgs/acme/permissions`, {
          headers: authHeaders(seed.owner.id),
        })
      ).json();
      expect(body).toEqual({
        can_read: false,
        can_write: false,
        is_admin: false,
        is_owner: false,
        can_create_repository: false,
      });
    }
  });

  it("is type-blind on the org param: a plain user answers all-false; a renamed org 307s", async () => {
    const seed = await seedOrg();
    const plainUser = await router()(
      `/users/${seed.owner.username}/orgs/${seed.outsider.username}/permissions`,
      { headers: authHeaders(seed.owner.id) },
    );
    expect(plainUser.status).toBe(200);
    expect(await plainUser.json()).toEqual({
      can_read: false,
      can_write: false,
      is_admin: false,
      is_owner: false,
      can_create_repository: false,
    });
    await new OrgService(env.DB).renameOrg(seed.orgId, "acme-two");
    const redirected = await router()(`/users/${seed.owner.username}/orgs/acme/permissions`, {
      headers: authHeaders(seed.owner.id),
    });
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("Location")).toBe(`/users/${seed.owner.username}/orgs/acme-two/permissions`);
  });

  it("401s anonymous callers (runtime-only) and 404s missing params", async () => {
    const seed = await seedOrg();
    const send = router();
    expect((await send(`/users/${seed.owner.username}/orgs/acme/permissions`)).status).toBe(401);
    expect(
      (await send(`/users/ghost-user/orgs/acme/permissions`, { headers: authHeaders(seed.owner.id) })).status,
    ).toBe(404);
    expect(
      (
        await send(`/users/${seed.owner.username}/orgs/ghost-org/permissions`, {
          headers: authHeaders(seed.owner.id),
        })
      ).status,
    ).toBe(404);
  });
});
