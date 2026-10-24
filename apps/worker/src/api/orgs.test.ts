/**
 * Tier-2 organization routes on real D1 (SPEC-0004 appendix A category a):
 * `GET/PATCH /orgs/{org}` (orgGet/orgEdit), the members family
 * (orgListMembers/orgIsMember/orgDeleteMember) and the public-members family
 * (orgListPublicMembers/orgIsPublicMember/orgPublicizeMember/orgConcealMember).
 * Orgs seed through the landed OrgService (org-as-user-row model, SPEC-0007)
 * and memberships through its addMember/setMemberRole primitives; the wire
 * shapes assert against the frozen contract — including the mirrored upstream
 * quirks: the anonymous email blank on GET /orgs/{org}, the members listing's
 * reqToken 401 (the swagger declares only 200/404), the 303 oracle redirect
 * on GET /orgs/{org}/members/{username}, the silent-204 member delete, the
 * 500 last-owner guard, the admin's all-members view of public_members, and
 * the renamed-org 307 seam.
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
