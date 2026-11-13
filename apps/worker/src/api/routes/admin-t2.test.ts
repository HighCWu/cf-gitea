/**
 * Tier-2 admin routes on real D1 (routes/admin-t2.ts — the table-free subset
 * of the contract's `admin` tag): adminSearchUsers/adminCreateUser
 * (GET/POST /admin/users), adminEditUser/adminDeleteUser
 * (PATCH/DELETE /admin/users/{username}), adminGetAllOrgs (GET /admin/orgs),
 * adminCreateOrg (POST /admin/users/{username}/orgs), adminRenameUser
 * (POST /admin/users/{username}/rename) and adminCreateRepo
 * (POST /admin/users/{username}/repos).
 *
 * Standalone mount per the tier2-extras.test.ts convention (the routes ARE
 * registered in router.ts by the orchestrator after this batch). The stub
 * resolver carries THREE tokens: the plain seed user (id 1), a non-admin
 * neighbor and the site admin ("root") — the whole module sits behind
 * requireAuth + the reqSiteAdmin gate, so both halves are exercisable.
 *
 * Upstream behavior pins mirrored by these assertions are cited in the
 * route-module header (routers/api/v1/admin/user.go / org.go / repo.go).
 */

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import {
  actions,
  auditEvents,
  issueAssignees,
  issueStopwatches,
  notificationStates,
  oauth2Applications,
  orgMembers,
  packageBlobs,
  packageFiles,
  packageProperties,
  packageVersions,
  packages,
  personalAccessTokens,
  protectedBranches,
  repositories,
  repoCounters,
  sessions,
  twoFactor,
  userBadges,
  userRedirects,
  users,
} from "../../db/schema";
import { verifyPassword } from "../../auth/password";
import { starRepo } from "../services/stars";
import { watchRepo } from "../services/repo-watchers";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { createStubAuthResolver, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerAdminT2Routes } from "./admin-t2";
import { OrgService } from "../../services/orgs/orgs";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";

const NOW = new Date("2026-02-03T04:05:06Z");
const TOKEN = "stub-token"; // the plain seed user (id 1, non-admin)
const TOKEN_NEIGHBOR = "neighbor-token"; // a non-admin neighbor
const TOKEN_ADMIN = "admin-token"; // the site admin ("root")

let neighborId = 0;
let adminId = 0;

function resolver(): AuthResolver {
  const stub = createStubAuthResolver();
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return stub.resolveToken(TOKEN);
      if (token === TOKEN_NEIGHBOR) {
        return Promise.resolve({ ...STUB_USER, id: neighborId, login: "neighbor" });
      }
      if (token === TOKEN_ADMIN) {
        return Promise.resolve({ ...STUB_USER, id: adminId, login: "root", is_admin: true });
      }
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void, envPatch?: Record<string, string>) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  const requestEnv = envPatch === undefined ? env : { ...env, ...envPatch };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), requestEnv));
}

const authed = (init?: RequestInit, token = TOKEN_ADMIN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const jsonAdmin = (body: unknown, method = "POST", token = TOKEN_ADMIN): RequestInit =>
  authed({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, token);

const jsonPatch = (body: unknown, token = TOKEN_ADMIN): RequestInit => jsonAdmin(body, "PATCH", token);

const adminSend = familyApp((app) => registerAdminT2Routes(app, createTokenAuthMiddleware(resolver())));

/** Census B-87: a sender whose request env carries knob overrides — the
 *  password config rides the structural PasswordConfigEnv slice, so the
 *  armed shapes pin without touching the shared rig env. */
const adminSendKnobs = (knobs: Record<string, string>): ReturnType<typeof familyApp> =>
  familyApp((app) => registerAdminT2Routes(app, createTokenAuthMiddleware(resolver())), knobs);

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

/** Fresh rows per test: the plain stub user (id 1), a neighbor, the admin. */
beforeEach(async () => {
  for (const table of [
    "personal_access_tokens",
    "protected_branches",
    "org_members",
    "user_redirects",
    "repo_watchers",
    "repo_collaborators",
    "reactions",
    "issue_subscriptions",
    "notification_states",
    "stopwatch",
    "issue_assignees",
    "user_badge",
    "oauth2_application",
    "action",
    "webhook_deliveries",
    "webhooks",
    "issue_pins",
    "issue_labels",
    "comments",
    "pull_requests",
    "issues",
    "milestones",
    "repo_topics",
    "repo_watchers",
    "repo_collaborators",
    "stars",
    "follows",
    "repo_counters",
    "commit_statuses",
    "repo_units",
    "repo_settings",
    "repo_transfer",
    "repo_redirects",
    "package_properties",
    "package_files",
    "package_versions",
    "packages",
    "package_blobs",
    "package_blob_uploads",
    "package_cleanup_rules",
    "audit_event",
    "two_factor",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  neighborId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  adminId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "root", usernameLower: "root", isAdmin: true, status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
});

/** Insert a repo registry row owned by the given user id (raw — the admin
 *  guards only count rows; the engine is not involved in this batch). */
async function seedRepo(ownerId: number, ownerNamespace: string, slug: string, id: string): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: NOW,
  });
}

/** One owned package with a published version, a lead file and a
 *  content-addressed blob row (the SPEC-0016 row shapes; the cascade and
 *  the guards count rows — the protocol layer is not involved). */
async function seedPackage(ownerId: number, name: string): Promise<void> {
  const pkg = (
    await drizzle(env.DB)
      .insert(packages)
      .values({ ownerId, type: "generic", name, lowerName: name.toLowerCase() })
      .returning({ id: packages.id })
      .all()
  )[0]!;
  const blob = (
    await drizzle(env.DB)
      .insert(packageBlobs)
      .values({ size: 7, hashSha256: `deadbeef${name.toLowerCase()}`, createdUnix: NOW })
      .returning({ id: packageBlobs.id })
      .all()
  )[0]!;
  const version = (
    await drizzle(env.DB)
      .insert(packageVersions)
      .values({ packageId: pkg.id, version: "1.0.0", lowerVersion: "1.0.0", createdUnix: NOW })
      .returning({ id: packageVersions.id })
      .all()
  )[0]!;
  await drizzle(env.DB).insert(packageFiles).values({
    versionId: version.id,
    blobId: blob.id,
    name: "file.bin",
    lowerName: "file.bin",
    createdUnix: NOW,
  });
}

/** One sessions row for the edit-arm's token-invalidation assertion (the
 *  remember rows are upstream's auth_token twin — UpdateAuth sweeps them on
 *  a password change, update.go:278-284; live rows are untouched). */
async function seedSession(userId: number, id: string, remember: boolean): Promise<void> {
  await drizzle(env.DB).insert(sessions).values({
    id,
    userId,
    sha256Digest: "a".repeat(64),
    rotatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    lastSeenAt: NOW,
    remember,
  });
}

// ---------------------------------------------------------------------------
// The admin gate (reqToken + reqSiteAdmin, api.go:1867)
// ---------------------------------------------------------------------------

describe("admin gating", () => {
  it("401s anonymous callers with the reqToken body", async () => {
    const res = await adminSend("/admin/users");
    expect(res.status).toBe(401);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("token is required");
    expect(String(body.url)).toContain("/api/swagger");
  });

  it("403s non-admins on every op with the reqSiteAdmin message", async () => {
    const checks: Array<[string, RequestInit]> = [
      ["/admin/users", authed(undefined, TOKEN_NEIGHBOR)],
      ["/admin/users", jsonAdmin({ username: "x", email: "x@example.com" }, "POST", TOKEN_NEIGHBOR)],
      ["/admin/users/neighbor", jsonAdmin({ full_name: "X" }, "PATCH", TOKEN_NEIGHBOR)],
      ["/admin/users/neighbor", authed({ method: "DELETE" }, TOKEN_NEIGHBOR)],
      ["/admin/orgs", authed(undefined, TOKEN_NEIGHBOR)],
      ["/admin/users/neighbor/orgs", jsonAdmin({ username: "neworg" }, "POST", TOKEN_NEIGHBOR)],
      ["/admin/users/neighbor/rename", jsonAdmin({ new_username: "moved" }, "POST", TOKEN_NEIGHBOR)],
      ["/admin/users/neighbor/repos", jsonAdmin({ name: "proj" }, "POST", TOKEN_NEIGHBOR)],
    ];
    for (const [path, init] of checks) {
      const res = await adminSend(path, init);
      expect(res.status).toBe(403);
      const body: Record<string, unknown> = await res.json();
      expect(body.message).toBe("user should be the site admin");
    }
  });
});

// ---------------------------------------------------------------------------
// POST /admin/users (adminCreateUser)
// ---------------------------------------------------------------------------

describe("POST /admin/users (adminCreateUser)", () => {
  it("creates a user and renders the contract User (email visible to the admin)", async () => {
    const res = await adminSend(
      "/admin/users",
      jsonAdmin({
        username: "newbie",
        email: "newbie@example.com",
        password: "Sup3r-Secret!",
        full_name: "New Bie",
        visibility: "limited",
        created_at: "2025-06-01T10:00:00Z",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(typeof body.id).toBe("number");
    expect(body).toMatchObject({
      login: "newbie",
      email: "newbie@example.com",
      full_name: "New Bie",
      type: "User",
      is_admin: false,
      active: true,
      prohibit_login: false,
      created: "2025-06-01T10:00:00.000Z",
    });

    const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "newbie")).limit(1);
    expect(row[0]?.email).toBe("newbie@example.com");
    expect(row[0]?.visibility).toBe("limited");
  });

  it("stores the hashed password record and the rands salt (user.go:788-794); must_change_password DEFAULTS TRUE (admin/user.go:89-95)", async () => {
    const res = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "hashed", email: "hashed@example.com", password: "Sup3r-Secret!" }),
    );
    expect(res.status).toBe(201);
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "hashed")).limit(1))[0]!;
    // The admin-user-edit.test.tsx stored-record pattern: SetPassword under
    // the CONFIGURED spec (new salt, pbkdf2$50000$50) plus the Rands salt
    // every upstream create writes (user.go:785-786).
    expect(row.passwd).toMatch(/^[0-9a-f]{100}$/);
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(row.passwdHashAlgo).toBe("pbkdf2$50000$50");
    expect(row.rands).toMatch(/^[0-9a-f]{32}$/);
    expect(row.mustChangePassword).toBe(true);
    expect(await verifyPassword("Sup3r-Secret!", row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
    expect(await verifyPassword("wrong-password", row.passwd, row.salt, row.passwdHashAlgo)).toBe(false);
  });

  it("400 PasswordIsRequired when the password is absent or below MinPasswordLength (admin/user.go:102-106)", async () => {
    const absent = await adminSend("/admin/users", jsonAdmin({ username: "nopass", email: "nopass@example.com" }));
    expect(absent.status).toBe(400);
    expect(((await absent.json<Record<string, unknown>>())).message).toBe("PasswordIsRequired");

    const short = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "shortpass", email: "short@example.com", password: "Aa1!Aa1" }),
    );
    expect(short.status).toBe(400);
    expect(((await short.json<Record<string, unknown>>())).message).toBe("PasswordIsRequired");
  });

  it("a long single-class password CREATES at the default config — upstream's unset PASSWORD_COMPLEXITY is checking OFF (security.go:209-218; census B-87's correction of the PW15 all-classes mis-derivation)", async () => {
    const res = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "weakpass", email: "weak@example.com", password: "alllowercase" }),
    );
    expect(res.status).toBe(201);
    const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "weakpass")).limit(1);
    expect(row[0]?.username).toBe("weakpass");
  });

  it("400 PasswordComplexity on a long single-class password when the knob is ARMED (admin/user.go:107-112 over PASSWORD_COMPLEXITY=lower,upper,digit,spec)", async () => {
    const send = adminSendKnobs({ PASSWORD_COMPLEXITY: "lower,upper,digit,spec" });
    const res = await send(
      "/admin/users",
      jsonAdmin({ username: "weakpass", email: "weak@example.com", password: "alllowercase" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("PasswordComplexity");
  });

  it("the armed min-length floor rides MIN_PASSWORD_LENGTH (MustInt(8) default; admin/user.go:103)", async () => {
    const send = adminSendKnobs({ MIN_PASSWORD_LENGTH: "16" });
    const short = await send(
      "/admin/users",
      jsonAdmin({ username: "floortest", email: "floor@example.com", password: "Sup3r-Short!" }),
    );
    expect(short.status).toBe(400);
    expect(((await short.json<Record<string, unknown>>())).message).toBe("PasswordIsRequired");
    // The same password clears the raised floor.
    const ok = await send(
      "/admin/users",
      jsonAdmin({ username: "floortest", email: "floor@example.com", password: "A-Longer-Password-Value!" }),
    );
    expect(ok.status).toBe(201);
  });

  it("persists must_change_password=false from the body; source_id/login_name/restricted stay accepted-and-ignored (deviation 1)", async () => {
    const res = await adminSend(
      "/admin/users",
      jsonAdmin({
        username: "tokenonly",
        email: "tokenonly@example.com",
        password: "Sup3r-Secret!",
        must_change_password: false,
        send_notify: true,
        source_id: 7,
        login_name: "ext-id",
        restricted: true,
      }),
    );
    expect(res.status).toBe(201);
    const body: Record<string, unknown> = await res.json();
    expect(body.active).toBe(true);
    // The explicit *bool override of the default-true (admin/user.go:93-95).
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "tokenonly")).limit(1))[0]!;
    expect(row.mustChangePassword).toBe(false);
  });

  it("409s on the shared-namespace collision and the duplicate email", async () => {
    const dupName = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "NEIGHBOR", email: "fresh@example.com", password: "Sup3r-Secret!" }),
    );
    expect(dupName.status).toBe(409);
    const nameBody: Record<string, unknown> = await dupName.json();
    expect(nameBody.message).toBe("user already exists [name: NEIGHBOR]");

    const first = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "fresh", email: "fresh@example.com", password: "Sup3r-Secret!" }),
    );
    expect(first.status).toBe(201);
    const dupEmail = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "fresh2", email: "FRESH@example.com", password: "Sup3r-Secret!" }),
    );
    expect(dupEmail.status).toBe(409);
    const emailBody: Record<string, unknown> = await dupEmail.json();
    expect(emailBody.message).toBe("e-mail already in use [email: FRESH@example.com]");
  });

  it("400s on unusable names and invalid emails AFTER the password ladder (upstream order, admin/user.go:102-142)", async () => {
    const reserved = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "org", email: "a@example.com", password: "Sup3r-Secret!" }),
    );
    expect(reserved.status).toBe(400);
    expect(((await reserved.json<Record<string, unknown>>())).message).toBe("name is reserved [name: org]");

    const chars = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "bad name", email: "a@example.com", password: "Sup3r-Secret!" }),
    );
    expect(chars.status).toBe(400);
    expect(((await chars.json<Record<string, unknown>>())).message).toBe(
      "name is invalid [bad name]: must be valid alpha or numeric or dash(-_) or dot characters",
    );

    const email = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "okname", email: "not-an-email", password: "Sup3r-Secret!" }),
    );
    expect(email.status).toBe(400);
    expect(((await email.json<Record<string, unknown>>())).message).toBe("email address is invalid: not-an-email");
  });

  it("consumes a live redirect at the created name (createUser tail)", async () => {
    await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "renamed" }));
    expect(await new OrgService(env.DB).lookupUserRedirect("neighbor")).toBe(neighborId);

    const res = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "neighbor", email: "n2@example.com", password: "Sup3r-Secret!" }),
    );
    expect(res.status).toBe(201);
    expect(await new OrgService(env.DB).lookupUserRedirect("neighbor")).toBeNull();
  });

  it("emits the user:create audit row — actor the ADMIN, scope the created user (B-73, admin/user.go:149)", async () => {
    const res = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "audited", email: "audited@example.com", password: "Sup3r-Secret!" }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json<Record<string, unknown>>()) as { id: number };
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "user:create",
      actorId: adminId, // ctx.Doer — the admin, not the created user
      actorName: "cf-gitea Stub User", // DisplayName (user.go:476-482): FullName set → FullName (the stub resolver's full_name)
      scopeType: "user",
      scopeId: String(created.id), // the decimal string (the scope_id drift note)
      scopeName: "audited",
      origin: "api",
      message: "Created user audited.", // the registry template rendered at emit
    });
    expect(rows[0]?.actorCredential).toBeNull();
    expect(rows[0]?.metadata).toBeNull();
  });

  it("emits NOTHING on a failed create — the audit row rolls back with the write (§4.2)", async () => {
    const first = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "first", email: "first@example.com", password: "Sup3r-Secret!" }),
    );
    expect(first.status).toBe(201);
    const dup = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "FIRST", email: "other@example.com", password: "Sup3r-Secret!" }),
    );
    expect(dup.status).toBe(409);
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scopeName).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/users (adminSearchUsers)
// ---------------------------------------------------------------------------

describe("GET /admin/users (adminSearchUsers)", () => {
  /** Seed three more users with distinct sort keys + states, plus one org
   *  (orgs are Individuals-only in the listing — Types=[UserTypeIndividual]). */
  beforeEach(async () => {
    await drizzle(env.DB).insert(users).values([
      { username: "alpha", usernameLower: "alpha", email: "alpha@example.com", fullName: "Alpha One", status: "active", visibility: "public", createdAt: new Date("2025-01-01T00:00:00Z") },
      { username: "bravo", usernameLower: "bravo", email: "bravo@example.com", fullName: "Bravo Two", status: "prohibited", visibility: "limited", createdAt: new Date("2025-03-01T00:00:00Z") },
      { username: "charlie", usernameLower: "charlie", email: "charlie@example.com", fullName: "Alpha Three", status: "active", visibility: "private", createdAt: new Date("2025-02-01T00:00:00Z") },
    ]);
    // Distinct creation timestamps for the seeded principal rows too.
    await env.DB.prepare("UPDATE users SET created_at = ?1 WHERE username_lower = 'cf-gitea-stub'")
      .bind(Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000))
      .run();
    await env.DB.prepare("UPDATE users SET created_at = ?1 WHERE username_lower = 'neighbor'")
      .bind(Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000))
      .run();
    await env.DB.prepare("UPDATE users SET created_at = ?1 WHERE username_lower = 'root'")
      .bind(Math.floor(new Date("2025-05-01T00:00:00Z").getTime() / 1000))
      .run();
    await new OrgService(env.DB).createOrg({ name: "orgshoulnotlist", ownerId: adminId });
  });

  it("lists only individual users, alphabetically, with the runtime list headers", async () => {
    const res = await adminSend("/admin/users", authed());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("6"); // stub + neighbor + root + 3 seeded; the org is excluded
    const listed: Array<Record<string, unknown>> = await res.json();
    expect(listed.map((entry) => entry.login)).toEqual([
      "alpha",
      "bravo",
      "cf-gitea-stub",
      "charlie",
      "neighbor",
      "root",
    ]);
    // The admin viewer gets the authed-only fields everywhere. (visibility
    // renders the converter's public TODO — services/user.ts — so the private
    // row is asserted on the column, not the render.)
    expect(listed[0]?.email).toBe("alpha@example.com");
    const charlieRow = await drizzle(env.DB)
      .select({ visibility: users.visibility })
      .from(users)
      .where(eq(users.usernameLower, "charlie"))
      .limit(1);
    expect(charlieRow[0]?.visibility).toBe("private");
  });

  it("filters by q (username, full name, email), flags and visibility", async () => {
    const byName = await adminSend("/admin/users?q=brav", authed());
    expect(((await byName.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["bravo"]);

    const byFullName = await adminSend("/admin/users?q=three", authed());
    expect(((await byFullName.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["charlie"]);

    const byEmail = await adminSend("/admin/users?q=alpha@example.com", authed());
    expect(((await byEmail.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["alpha"]);

    const admins = await adminSend("/admin/users?is_admin=true", authed());
    expect(((await admins.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["root"]);

    const inactive = await adminSend("/admin/users?is_active=false", authed());
    expect(((await inactive.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["bravo"]);

    const prohibited = await adminSend("/admin/users?is_prohibit_login=true", authed());
    expect(((await prohibited.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["bravo"]);

    const limited = await adminSend("/admin/users?visibility=limited", authed());
    expect(((await limited.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["bravo"]);
  });

  it("sorts by name/created/id with asc/desc and 422s invalid sort/order/visibility", async () => {
    const createdDesc = await adminSend("/admin/users?sort=created&order=desc", authed());
    const desc: Array<Record<string, unknown>> = await createdDesc.json();
    // neighbor (2026) > root (2025-05) > bravo (2025-03) > charlie (2025-02)
    // > alpha (2025-01) > stub (2024).
    expect(desc.map((entry) => entry.login)).toEqual([
      "neighbor",
      "root",
      "bravo",
      "charlie",
      "alpha",
      "cf-gitea-stub",
    ]);

    const idDesc = await adminSend("/admin/users?sort=id&order=desc", authed());
    const ids: Array<Record<string, unknown>> = await idDesc.json();
    const numeric = ids.map((entry) => entry.id as number);
    expect([...numeric].sort((a, b) => b - a)).toEqual(numeric);

    const nameDesc = await adminSend("/admin/users?sort=name&order=desc", authed());
    const names: Array<Record<string, unknown>> = await nameDesc.json();
    expect(names.map((entry) => entry.login)).toEqual([
      "alpha",
      "bravo",
      "cf-gitea-stub",
      "charlie",
      "neighbor",
      "root",
    ].reverse());

    const badMode = await adminSend("/admin/users?sort=bogus", authed());
    expect(badMode.status).toBe(422);
    expect(((await badMode.json<Record<string, unknown>>())).message).toBe('Invalid sort mode: "bogus"');

    const badOrder = await adminSend("/admin/users?sort=name&order=sideways", authed());
    expect(badOrder.status).toBe(422);
    expect(((await badOrder.json<Record<string, unknown>>())).message).toBe('Invalid sort order: "sideways"');

    const badVisibility = await adminSend("/admin/users?visibility=secret", authed());
    expect(badVisibility.status).toBe(422);
    expect(((await badVisibility.json<Record<string, unknown>>())).message).toBe("invalid visibility");
  });

  it("evaluates the unmodeled-column filters against the constant state (deviation 4)", async () => {
    // Every cf-gitea user is local and un-restricted: the false filters match
    // everyone, the true filters match nothing. (The 2FA filter left this
    // deviation when the two_factor store landed — its own describe below.)
    const locals = await adminSend("/admin/users?source_id=0", authed());
    expect(locals.headers.get("X-Total-Count")).toBe("6");
    const foreign = await adminSend("/admin/users?source_id=7", authed());
    expect(foreign.headers.get("X-Total-Count")).toBe("0");
    const unrestricted = await adminSend("/admin/users?is_restricted=false", authed());
    expect(unrestricted.headers.get("X-Total-Count")).toBe("6");
    const restricted = await adminSend("/admin/users?is_restricted=true", authed());
    expect(restricted.headers.get("X-Total-Count")).toBe("0");
    const external = await adminSend("/admin/users?login_name=ext-id", authed());
    expect(external.headers.get("X-Total-Count")).toBe("0");
  });

  it("reads the is_2fa_enabled filter against the two_factor store — BOTH polarities (search.go:142-162)", async () => {
    // One enrolled user (the LEFT JOIN's non-NULL uid row; our store keeps
    // one row per uid, UNIQUE(two_factor_uid_uq)) — everyone else is the
    // NULL-join side.
    await drizzle(env.DB).insert(twoFactor).values({
      userId: neighborId,
      secret: "JBSWY3DPEHPK3PXP",
      scratchSalt: "salt",
      scratchHash: "hash",
      createdUnix: Math.floor(NOW.getTime() / 1000),
      updatedUnix: Math.floor(NOW.getTime() / 1000),
    });
    const enrolled = await adminSend("/admin/users?is_2fa_enabled=true", authed());
    expect(((await enrolled.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["neighbor"]);
    const plain = await adminSend("/admin/users?is_2fa_enabled=false", authed());
    expect(plain.headers.get("X-Total-Count")).toBe("5");
    expect(
      (await plain.json<Array<Record<string, unknown>>>()).every((entry) => entry.login !== "neighbor"),
    ).toBe(true);
  });

  it("paginates with silent clamping", async () => {
    const page = await adminSend("/admin/users?limit=2&page=2", authed());
    expect(page.headers.get("X-Total-Count")).toBe("6");
    const listed: Array<Record<string, unknown>> = await page.json();
    expect(listed.map((entry) => entry.login)).toEqual(["cf-gitea-stub", "charlie"]);
    expect(page.headers.get("Link")).toContain('rel="next"');
    expect(page.headers.get("Link")).toContain('rel="first"');
  });

  // --- the deferred arms (the polish wave) — cites: routers/api/v1/utils/
  // sort.go:18-41 (ResolveHostSortOrder's order-first map), models/user/
  // search.go:21-36 (AdminUserOrderByMap — 'updated' → updated_unix, the
  // landed created_at stand-in, admin-t2 deviation 5), search.go:76-170
  // (SearchUsers' ANDed filter row), services/convert/utils.go
  // ToCorrectPageSize (the silent 50 cap). --------------------------------

  it("sorts by 'updated' through the created_at stand-in in both directions (deviation 5)", async () => {
    // The describe's beforeEach stamped distinct created_at values:
    // stub 2024 < alpha 2025-01 < charlie 2025-02 < bravo 2025-03
    // < root 2025-05 < neighbor 2026.
    const updatedAsc = await adminSend("/admin/users?sort=updated", authed());
    const asc: Array<Record<string, unknown>> = await updatedAsc.json();
    expect(asc.map((entry) => entry.login)).toEqual([
      "cf-gitea-stub",
      "alpha",
      "charlie",
      "bravo",
      "root",
      "neighbor",
    ]);

    const updatedDesc = await adminSend("/admin/users?sort=updated&order=desc", authed());
    const desc: Array<Record<string, unknown>> = await updatedDesc.json();
    expect(desc.map((entry) => entry.login)).toEqual([
      "neighbor",
      "root",
      "bravo",
      "charlie",
      "alpha",
      "cf-gitea-stub",
    ]);
  });

  it("order without sort is ignored; an explicit order=asc applies (utils/sort.go:18-41)", async () => {
    // sortMode "" short-circuits BEFORE the order read: the default
    // (alphabetically, asc) answers even with order=desc in the URL.
    const orderOnly = await adminSend("/admin/users?order=desc", authed());
    const orderedList: Array<Record<string, unknown>> = await orderOnly.json();
    expect(orderedList.map((entry) => entry.login)).toEqual([
      "alpha",
      "bravo",
      "cf-gitea-stub",
      "charlie",
      "neighbor",
      "root",
    ]);

    const explicitAsc = await adminSend("/admin/users?sort=name&order=asc", authed());
    expect(((await explicitAsc.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual([
      "alpha",
      "bravo",
      "cf-gitea-stub",
      "charlie",
      "neighbor",
      "root",
    ]);
  });

  it("an unknown ORDER 422s before an unknown SORT — the map is keyed order-first (utils/sort.go:26-33)", async () => {
    const both = await adminSend("/admin/users?sort=bogus&order=sideways", authed());
    expect(both.status).toBe(422);
    expect(((await both.json<Record<string, unknown>>())).message).toBe('Invalid sort order: "sideways"');
  });

  it("the q keyword ANDs with the boolean/visibility filters (search.go:76-170's conditions slice)", async () => {
    // q hits bravo; the inactive filter keeps it.
    const interplay = await adminSend("/admin/users?q=brav&is_active=false", authed());
    expect(((await interplay.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["bravo"]);

    // q hits alpha; the admin filter excludes it — empty intersection.
    const conflict = await adminSend("/admin/users?q=alpha&is_admin=true", authed());
    expect(conflict.headers.get("X-Total-Count")).toBe("0");

    // the email-keyword arm composes with is_active=true.
    const emailActive = await adminSend("/admin/users?q=alpha@example.com&is_active=true", authed());
    expect(((await emailActive.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["alpha"]);

    // the full-name arm composes with visibility.
    const namePrivate = await adminSend("/admin/users?q=three&visibility=private", authed());
    expect(((await namePrivate.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual(["charlie"]);

    // the keyword is case-folded BEFORE the match (search.go:87-99's LOWER
    // arm) — and "alph" hits TWO rows: alpha's username AND charlie's
    // "Alpha Three" full name.
    const folded = await adminSend("/admin/users?q=ALPH", authed());
    expect(((await folded.json<Array<Record<string, unknown>>>())).map((entry) => entry.login)).toEqual([
      "alpha",
      "charlie",
    ]);
  });

  it("the affirmative flag arms: is_active=true and is_prohibit_login=false both select the active five", async () => {
    const active = await adminSend("/admin/users?is_active=true", authed());
    const activeList = await active.json<Array<Record<string, unknown>>>();
    expect(activeList.map((entry) => entry.login).sort()).toEqual([
      "alpha",
      "cf-gitea-stub",
      "charlie",
      "neighbor",
      "root",
    ]);

    const allowed = await adminSend("/admin/users?is_prohibit_login=false", authed());
    expect(((await allowed.json<Array<Record<string, unknown>>>())).map((entry) => entry.login).sort()).toEqual([
      "alpha",
      "cf-gitea-stub",
      "charlie",
      "neighbor",
      "root",
    ]);
  });

  it("the pager caps at exactly 50 (ToCorrectPageSize) with the true total in the headers", async () => {
    // 6 fixture users + 49 seeded = 55: enough to observe the cap AND the
    // 50-boundary second page. Single-row inserts — D1 caps a statement at
    // 100 bound variables, and one users row carries 19.
    for (let i = 0; i < 49; i++) {
      await drizzle(env.DB).insert(users).values({
        username: `bulk${String(i).padStart(2, "0")}`,
        usernameLower: `bulk${String(i).padStart(2, "0")}`,
        status: "active",
        visibility: "public",
        createdAt: new Date("2025-07-01T00:00:00Z"),
      });
    }

    // The cap: limit=51 clamps to 50 rows; X-Total-Count stays the TRUE 55.
    const capped = await adminSend("/admin/users?limit=51", authed());
    expect(capped.headers.get("X-Total-Count")).toBe("55");
    expect((await capped.json<Array<Record<string, unknown>>>())).toHaveLength(50);
    expect(capped.headers.get("Link")).toContain('rel="next"');

    // The absent limit rides the 30 default.
    const defaulted = await adminSend("/admin/users", authed());
    expect(defaulted.headers.get("X-Total-Count")).toBe("55");
    expect((await defaulted.json<Array<Record<string, unknown>>>())).toHaveLength(30);

    // Exactly 50 per page: page 1 carries no prev/first; page 2 the 5 leftovers.
    const p1 = await adminSend("/admin/users?limit=50", authed());
    expect((await p1.json<Array<Record<string, unknown>>>())).toHaveLength(50);
    const p1Link = p1.headers.get("Link") ?? "";
    expect(p1Link).toContain('rel="next"');
    expect(p1Link).toContain('rel="last"');
    expect(p1Link).not.toContain('rel="prev"');
    expect(p1Link).not.toContain('rel="first"');

    const p2 = await adminSend("/admin/users?limit=50&page=2", authed());
    expect((await p2.json<Array<Record<string, unknown>>>())).toHaveLength(5);
    const p2Link = p2.headers.get("Link") ?? "";
    expect(p2Link).toContain('rel="prev"');
    expect(p2Link).toContain('rel="first"');
    expect(p2Link).not.toContain('rel="next"');

    // Junk limits fold onto the default (never a 422 — the silent clamp).
    for (const junk of ["abc", "-1", "0"]) {
      const junked = await adminSend(`/admin/users?limit=${junk}`, authed());
      expect(junked.status, junk).toBe(200);
      expect((await junked.json<Array<Record<string, unknown>>>()), junk).toHaveLength(30);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/users/{username} (adminEditUser)
// ---------------------------------------------------------------------------

describe("PATCH /admin/users/{username} (adminEditUser)", () => {
  it("patches profile fields, email and visibility; 200 renders the edited User", async () => {
    const res = await adminSend(
      "/admin/users/neighbor",
      jsonPatch({
        full_name: "Neighbor Person",
        description: "bio text",
        website: "https://neighbor.example.com",
        location: "somewhere",
        visibility: "limited",
        email: "moved@example.com",
      }),
    );
    expect(res.status).toBe(200);
    const body: Record<string, unknown> = await res.json();
    // The render subset the landed converter carries (services/user.ts renders
    // description/location/website as "" and visibility as the public TODO);
    // the persisted columns are asserted on the row below.
    expect(body).toMatchObject({
      login: "neighbor",
      full_name: "Neighbor Person",
      email: "moved@example.com",
    });
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1);
    expect(row[0]).toMatchObject({
      fullName: "Neighbor Person",
      displayName: "Neighbor Person",
      description: "bio text",
      website: "https://neighbor.example.com",
      location: "somewhere",
      visibility: "limited",
      email: "moved@example.com",
    });
  });

  it("folds active/prohibit_login into the status column (deviation 6)", async () => {
    const off = await adminSend("/admin/users/neighbor", jsonPatch({ active: false }));
    expect(off.status).toBe(200);
    expect(((await off.json<Record<string, unknown>>())).prohibit_login).toBe(true);

    const back = await adminSend("/admin/users/neighbor", jsonPatch({ active: true }));
    expect(((await back.json<Record<string, unknown>>())).active).toBe(true);

    const prohibit = await adminSend("/admin/users/neighbor", jsonPatch({ prohibit_login: true }));
    expect(((await prohibit.json<Record<string, unknown>>())).prohibit_login).toBe(true);
  });

  it("grants admin; demoting the LAST admin 400s with the upstream message", async () => {
    // root is the only admin: the false-set hits the last-admin guard.
    const demote = await adminSend("/admin/users/root", jsonPatch({ admin: false }));
    expect(demote.status).toBe(400);
    expect(((await demote.json<Record<string, unknown>>())).message).toBe(
      `can not delete the last admin user [uid: ${adminId}]`,
    );

    const grant = await adminSend("/admin/users/neighbor", jsonPatch({ admin: true }));
    expect(grant.status).toBe(200);
    expect(((await grant.json<Record<string, unknown>>())).is_admin).toBe(true);
  });

  it("409s a duplicate email; the same address is a case-insensitive no-op", async () => {
    await drizzle(env.DB).update(users).set({ email: "root@example.com" }).where(eq(users.id, adminId));

    const conflict = await adminSend("/admin/users/neighbor", jsonPatch({ email: "root@example.com" }));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json<Record<string, unknown>>())).message).toBe(
      "e-mail already in use [email: root@example.com]",
    );

    const same = await adminSend("/admin/users/root", jsonPatch({ email: "ROOT@example.com" }));
    expect(same.status).toBe(200);
  });

  it("sets the password through the UpdateAuth ladder: hash stored, remember sessions swept, live rows kept (admin/user.go:203-226)", async () => {
    await seedSession(neighborId, "sess-remember", true);
    await seedSession(neighborId, "sess-live", false);
    const before = (await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1))[0]!;

    const res = await adminSend("/admin/users/neighbor", jsonPatch({ password: "Br4vo-Fourte" }));
    expect(res.status).toBe(200);

    const after = (await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1))[0]!;
    expect(after.passwd).not.toBe(before.passwd);
    expect(after.salt).not.toBe(before.salt);
    expect(after.passwdHashAlgo).toBe("pbkdf2$50000$50");
    expect(await verifyPassword("Br4vo-Fourte", after.passwd, after.salt, after.passwdHashAlgo)).toBe(true);
    // The old record is REPLACED, not verified-against: the honest
    // before/after assertion is the algorithm column itself (asserted above
    // — SetPassword writes the CONFIGURED spec; B-86's landed argon2/bcrypt
    // verify arms would verify a seeded old row, which is exactly why the
    // replacement, not the verify, is the assertion).

    // update.go:278-284 — the token invalidation: the remember rows (our
    // auth_token twin) die, live non-remember sessions are untouched.
    const remaining = await drizzle(env.DB).select().from(sessions).where(eq(sessions.userId, neighborId)).all();
    expect(remaining.map((s) => s.id).sort()).toEqual(["sess-live"]);
  });

  it("absent and empty password leave the stored record untouched (optional.FromNonDefault, update.go:249)", async () => {
    const before = (await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1))[0]!;

    const absent = await adminSend("/admin/users/neighbor", jsonPatch({ full_name: "Renamed" }));
    expect(absent.status).toBe(200);
    const empty = await adminSend("/admin/users/neighbor", jsonPatch({ password: "" }));
    expect(empty.status).toBe(200);

    const after = (await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1))[0]!;
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
    expect(after.passwdHashAlgo).toBe(before.passwdHashAlgo);
  });

  it("walks the edit password ladder with the UpdateAuth texts — DIFFERENT from create's bare codes (admin/user.go:212-216)", async () => {
    const short = await adminSend("/admin/users/neighbor", jsonPatch({ password: "Aa1!Aa1" }));
    expect(short.status).toBe(400);
    expect(((await short.json<Record<string, unknown>>())).message).toBe("password must be at least 8 characters");

    // The complexity arm at the DEFAULT config does not fire (upstream's
    // unset PASSWORD_COMPLEXITY is checking OFF — census B-87's correction):
    // the weak long password EDITS cleanly.
    const weakOk = await adminSend("/admin/users/neighbor", jsonPatch({ password: "alllowercase-long" }));
    expect(weakOk.status).toBe(200);

    // The ARMED knob gates the edit arm with the same UpdateAuth text.
    const send = adminSendKnobs({ PASSWORD_COMPLEXITY: "lower,upper,digit,spec" });
    const complex = await send("/admin/users/neighbor", jsonPatch({ password: "alllowercase-long" }));
    expect(complex.status).toBe(400);
    expect(((await complex.json<Record<string, unknown>>())).message).toBe("password not complex enough");

    // MIN_PASSWORD_LENGTH moves the edit arm's fmt string too (admin/user.go:213).
    const raised = adminSendKnobs({ MIN_PASSWORD_LENGTH: "16" });
    const floorText = await raised("/admin/users/neighbor", jsonPatch({ password: "Aa1!Aa1" }));
    expect(floorText.status).toBe(400);
    expect(((await floorText.json<Record<string, unknown>>())).message).toBe(
      "password must be at least 16 characters",
    );
  });

  it("must_change_password: create defaults TRUE, the edit arm sets and clears it (update.go:265-267)", async () => {
    const created = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "mcpuser", email: "mcp@example.com", password: "Sup3r-Secret!" }),
    );
    expect(created.status).toBe(201);
    const createdRow = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "mcpuser")).limit(1))[0]!;
    expect(createdRow.mustChangePassword).toBe(true);

    const cleared = await adminSend("/admin/users/mcpuser", jsonPatch({ must_change_password: false }));
    expect(cleared.status).toBe(200);
    const clearedRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, createdRow.id)).limit(1))[0]!;
    expect(clearedRow.mustChangePassword).toBe(false);

    const set = await adminSend("/admin/users/mcpuser", jsonPatch({ must_change_password: true }));
    expect(set.status).toBe(200);
    const setRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, createdRow.id)).limit(1))[0]!;
    expect(setRow.mustChangePassword).toBe(true);
  });

  it("the bot auth-material guard 400s before the conversion arms (admin/user.go:200-204)", async () => {
    const withPassword = await adminSend(
      "/admin/users/neighbor",
      jsonPatch({ type: "Bot", password: "Sup3r-Secret!" }),
    );
    expect(withPassword.status).toBe(400);
    expect(((await withPassword.json<Record<string, unknown>>())).message).toBe(
      "a bot account cannot have a password or authentication source",
    );

    const withSource = await adminSend("/admin/users/neighbor", jsonPatch({ type: "Bot", login_name: "ext-id" }));
    expect(withSource.status).toBe(400);
    expect(((await withSource.json<Record<string, unknown>>())).message).toBe(
      "a bot account cannot have a password or authentication source",
    );
  });

  it("walks the type arms: Organization 400 parse, admin→Bot 400, plain→Bot the deviation 400", async () => {
    const org = await adminSend("/admin/users/neighbor", jsonPatch({ type: "Organization" }));
    expect(org.status).toBe(400);
    expect(((await org.json<Record<string, unknown>>())).message).toBe(
      'invalid user type "Organization" (expected User, Bot)',
    );

    const botAdmin = await adminSend("/admin/users/root", jsonPatch({ type: "Bot" }));
    expect(botAdmin.status).toBe(400);
    expect(((await botAdmin.json<Record<string, unknown>>())).message).toBe(
      "bot user can not be a site administrator",
    );

    const botPlain = await adminSend("/admin/users/neighbor", jsonPatch({ type: "Bot" }));
    expect(botPlain.status).toBe(400);
    expect(((await botPlain.json<Record<string, unknown>>())).message).toBe("user type can not be converted");
  });

  it("404s a missing user and 307s a renamed one (UserAssignmentAPI seam)", async () => {
    const missing = await adminSend("/admin/users/ghost", jsonPatch({ full_name: "x" }));
    expect(missing.status).toBe(404);
    expect(((await missing.json<Record<string, unknown>>())).message).toBe(
      "user redirect does not exist [name: ghost]",
    );

    await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "renamed" }));
    const redirected = await adminSend("/admin/users/neighbor", jsonPatch({ full_name: "x" }));
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("Location")).toBe("/admin/users/renamed");
  });
});

// ---------------------------------------------------------------------------
// DELETE /admin/users/{username} (adminDeleteUser)
// ---------------------------------------------------------------------------

describe("DELETE /admin/users/{username} (adminDeleteUser)", () => {
  it("deletes the user and sweeps the user-adjacent stores (204)", async () => {
    await drizzle(env.DB).insert(personalAccessTokens).values({
      userId: neighborId,
      name: "cli",
      prefix: "cfg_abcd1234",
      sha256Digest: "0".repeat(64),
      scopes: "all",
      createdAt: NOW,
    });
    await drizzle(env.DB).insert(userRedirects).values({ lowerName: "old-neighbor", redirectUserId: neighborId });
    await env.DB.prepare("INSERT INTO follows (user_id, follow_id, created_at) VALUES (?1, ?2, 0)")
      .bind(neighborId, adminId)
      .run();
    // A rule on the admin's repo whitelisting the neighbor across the lists
    // (SPEC-0013 M4 — the delete.go:134-155 "Branch Protections" block).
    await seedRepo(adminId, "root", "guarded", "adm_repo_1");
    await drizzle(env.DB).insert(protectedBranches).values({
      repoId: "adm_repo_1",
      ruleName: "main",
      priority: 1,
      rules: serializeRuleConfig({
        ...emptyRuleConfig(),
        whitelistUserIds: [neighborId, adminId],
        mergeWhitelistUserIds: [neighborId],
        approvalsWhitelistUserIds: [adminId],
        bypassAllowlistUserIds: [neighborId],
      }),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await adminSend("/admin/users/neighbor", authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId))).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(personalAccessTokens)).toHaveLength(0); // FK cascade
    expect(await new OrgService(env.DB).lookupUserRedirect("old-neighbor")).toBeNull(); // FK cascade
    // The whitelist scrub: every reference to the deleted id is gone from the
    // rule; the other principal's references survive.
    const rule = (await drizzle(env.DB).select().from(protectedBranches).all())[0];
    expect(rule).not.toBeUndefined();
    const config = JSON.parse(rule!.rules) as Record<string, number[]>;
    expect(config.whitelist_user_ids).toEqual([adminId]);
    expect(config.merge_whitelist_user_ids).toEqual([]);
    expect(config.approvals_whitelist_user_ids).toEqual([adminId]);
    expect(config.bypass_allowlist_user_ids).toEqual([]);
  });

  it("422s the guard ladder: org target, self, repos, memberships", async () => {
    const org = await new OrgService(env.DB).createOrg({ name: "theorg", ownerId: adminId });

    const orgTarget = await adminSend(`/admin/users/${org.username}`, authed({ method: "DELETE" }));
    expect(orgTarget.status).toBe(422);
    expect(((await orgTarget.json<Record<string, unknown>>())).message).toBe(
      "target is an organization but not user",
    );

    const self = await adminSend("/admin/users/root", authed({ method: "DELETE" }));
    expect(self.status).toBe(422);
    expect(((await self.json<Record<string, unknown>>())).message).toBe("you cannot delete yourself");

    await seedRepo(neighborId, "neighbor", "held", "9100");
    const ownsRepos = await adminSend("/admin/users/neighbor", authed({ method: "DELETE" }));
    expect(ownsRepos.status).toBe(422);
    expect(((await ownsRepos.json<Record<string, unknown>>())).message).toBe(
      `user still has ownership of repositories [uid: ${neighborId}]`,
    );
    await env.DB.prepare("DELETE FROM repositories").run();

    await drizzle(env.DB).insert(orgMembers).values({
      orgId: org.id,
      userId: neighborId,
      isPublic: false,
      role: "member",
      createdAt: NOW,
    });
    const member = await adminSend("/admin/users/neighbor", authed({ method: "DELETE" }));
    expect(member.status).toBe(422);
    expect(((await member.json<Record<string, unknown>>())).message).toBe(
      `user still has membership of organizations [uid: ${neighborId}]`,
    );

    // The third in-tx guard (user.go:250-255 → HasOwnerPackages, the INNER
    // JOIN over non-internal versions): verbatim ErrUserOwnPackages body.
    await env.DB.prepare("DELETE FROM org_members").run();
    await seedPackage(neighborId, "held-pkg");
    const ownsPackages = await adminSend("/admin/users/neighbor", authed({ method: "DELETE" }));
    expect(ownsPackages.status).toBe(422);
    expect(((await ownsPackages.json<Record<string, unknown>>())).message).toBe(
      `user still has ownership of packages [uid: ${neighborId}]`,
    );
  });

  it("purge=true cascades BOTH owned repos through the real deleteRepository pipeline (204)", async () => {
    await seedRepo(neighborId, "neighbor", "first", "9110");
    await seedRepo(neighborId, "neighbor", "second", "9111");
    // A repo-scoped dependent under each — the cascade's D1 half clears it.
    await drizzle(env.DB).insert(repoCounters).values([
      { repoId: "9110", issueIndex: 3 },
      { repoId: "9111", issueIndex: 4 },
    ]);
    // Engine registry entries for both combined names — only the REAL
    // pipeline (deleteRepository's registry removal) takes them away; a raw
    // row drop would leave them resolving against dead storage.
    const registry = env.REGISTRY.getByName("registry");
    await registry.upsert("neighbor/first", Date.now());
    await registry.upsert("neighbor/second", Date.now());

    const res = await adminSend("/admin/users/neighbor?purge=true", authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId))).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(0);
    // The engine half ran: both entries are gone.
    expect(await registry.get("neighbor/first")).toBeNull();
    expect(await registry.get("neighbor/second")).toBeNull();
  });

  it("purge=true removes org memberships; a last-owner org is deleted WITH its repos (the RemoveOrgUser/DeleteOrganization loop)", async () => {
    const orgs = new OrgService(env.DB);
    // Arm A — plain member of an admin-owned org: membership removed
    // (counter maintained), the org itself survives.
    const memberOrg = await orgs.createOrg({ name: "member-org", ownerId: adminId });
    await orgs.addMember(memberOrg.id, neighborId);
    // Arm B — neighbor is the LAST OWNER of an org that owns a repo: removeMember
    // raises the last-owner error, so upstream DELETES the organization with
    // purge=true (user.go:209 → DeleteOrganization's purge arm deletes the
    // org's repos first) — mirrored with the same repo cascade + deleteOrg.
    const ownedOrg = await orgs.createOrg({ name: "owned-org", ownerId: neighborId });
    await seedRepo(ownedOrg.id, "owned-org", "held", "9120");

    const res = await adminSend("/admin/users/neighbor?purge=true", authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId))).toHaveLength(0);
    expect(await orgs.getMembership(memberOrg.id, neighborId)).toBeNull();
    const surviving = await orgs.getOrgById(memberOrg.id);
    expect(surviving?.numMembers).toBe(1);
    expect(await orgs.getOrgById(ownedOrg.id)).toBeNull();
    // Both the owned org's repo and every other repo row are gone.
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
  });

  it("purge=true sweeps the owned packages — versions, files, properties and package rows gone; blob content rides the sole-deleter sweep (the RemoveAllPackages arm)", async () => {
    await seedPackage(neighborId, "doomed");
    // Sanity: the purge ran over a REAL store (one package, one version, one
    // file, one blob row).
    expect(await drizzle(env.DB).select().from(packages).all()).toHaveLength(1);
    expect(await drizzle(env.DB).select().from(packageVersions).all()).toHaveLength(1);

    const res = await adminSend("/admin/users/neighbor?purge=true", authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId))).toHaveLength(0);
    // The rows-then-sweep shape (services/packages/packages.go:720-750
    // deletes rows only; the content store is CleanupTask's): package,
    // version, file and property rows are GONE.
    expect(await drizzle(env.DB).select().from(packages).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(packageVersions).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(packageFiles).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(packageProperties).all()).toHaveLength(0);
    // The blob ROW survives with zero file references — the hourly
    // package-cleanup sweep (the SOLE content-key deleter, ratification 4)
    // deletes the row + its `packages/blobs/…` R2 key past the window. That
    // is upstream's own split: RemoveAllPackages never touches the content
    // store, CleanupTask's DeleteUnreferencedBlobs owns it.
    const blobRows = await drizzle(env.DB).select().from(packageBlobs).all();
    expect(blobRows).toHaveLength(1);
  });

  it("sweeps the full census without purge: star/watch counters drop with the edges, the FK-less stores clear (204)", async () => {
    await seedRepo(adminId, "root", "surviving", "9130");
    // Real counter-maintaining services (stars.ts / repo-watchers.ts): both
    // repositories counters and the user tally move with the edges.
    await starRepo(env.DB, neighborId, "9130", NOW);
    await watchRepo(env.DB, "9130", neighborId, NOW);
    // The census's post-landing FK-less families, one row each (the landed
    // route batch covered only watcher/collaborator/reaction/subscription).
    await drizzle(env.DB).insert(notificationStates).values({ userId: neighborId, issueId: 1 });
    await drizzle(env.DB).insert(issueStopwatches).values({ issueId: 1, userId: neighborId, createdAt: NOW });
    await drizzle(env.DB).insert(issueAssignees).values({ issueId: 1, assigneeId: neighborId });
    await drizzle(env.DB).insert(userBadges).values({ badgeId: 1, userId: neighborId });
    await drizzle(env.DB).insert(oauth2Applications).values({
      uid: neighborId,
      name: "app",
      clientId: "client-xyz",
      clientSecret: "secret",
      createdAt: NOW,
      updatedAt: NOW,
    });
    // action: the census deletes the RECEIVER rows (Action{UserID},
    // delete.go:82) — a row where neighbor only PERFORMED (admin receives)
    // survives, upstream's ghost-feed posture.
    await drizzle(env.DB).insert(actions).values([
      { userId: neighborId, opType: 1, actUserId: adminId, repoId: "9130", createdAt: NOW },
      { userId: adminId, opType: 1, actUserId: neighborId, repoId: "9130", createdAt: NOW },
    ]);

    const res = await adminSend("/admin/users/neighbor", authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId))).toHaveLength(0);
    const survivingRepo = (
      await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "9130")).limit(1)
    )[0];
    expect(survivingRepo?.numStars).toBe(0);
    expect(survivingRepo?.numWatches).toBe(0);
    expect(await drizzle(env.DB).select().from(notificationStates).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(issueStopwatches).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(issueAssignees).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(userBadges).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(oauth2Applications).all()).toHaveLength(0);
    // The cascade's action delete covers BOTH columns (the probe-caught fix,
    // 2026-10-29): the neighbor's ACTOR row below dies with them now — the
    // pre-fix cascade keyed the receiver column alone and this row survived
    // (that orphan class was the live observation that caught the bug).
    const remainingActions = await drizzle(env.DB).select().from(actions).all();
    expect(remainingActions).toHaveLength(0);
  });

  it("404s a missing user", async () => {
    const res = await adminSend("/admin/users/ghost", authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("user redirect does not exist [name: ghost]");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/orgs (adminGetAllOrgs)
// ---------------------------------------------------------------------------

describe("GET /admin/orgs (adminGetAllOrgs)", () => {
  it("lists ALL orgs (the full visibility ladder) alphabetically with headers", async () => {
    await new OrgService(env.DB).createOrg({ name: "acme", ownerId: adminId, email: "acme@example.com" });
    await new OrgService(env.DB).createOrg({ name: "zeta", ownerId: adminId, visibility: "private" });

    const res = await adminSend("/admin/orgs", authed());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const listed: Array<Record<string, unknown>> = await res.json();
    expect(listed.map((entry) => entry.username)).toEqual(["acme", "zeta"]);
    expect(listed[0]).toMatchObject({
      name: "acme",
      username: "acme",
      email: "acme@example.com",
      visibility: "public",
    });
    expect(typeof listed[0]?.id).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// POST /admin/users/{username}/orgs (adminCreateOrg)
// ---------------------------------------------------------------------------

describe("POST /admin/users/{username}/orgs (adminCreateOrg)", () => {
  it("creates an org OWNED BY THE TARGET (201 Organization)", async () => {
    const res = await adminSend(
      "/admin/users/neighbor/orgs",
      jsonAdmin({
        username: "neighbors-org",
        full_name: "Neighbor's Org",
        description: "d",
        website: "https://org.example.com",
        location: "loc",
        email: "org@example.com",
        visibility: "private",
        repo_admin_change_team_access: true,
      }),
    );
    expect(res.status).toBe(201);
    const body: Record<string, unknown> = await res.json();
    expect(body).toMatchObject({
      username: "neighbors-org",
      name: "neighbors-org",
      full_name: "Neighbor's Org",
      description: "d",
      website: "https://org.example.com",
      location: "loc",
      email: "org@example.com",
      visibility: "private",
      repo_admin_change_team_access: true,
    });

    // The target — not the admin — is the owner row (admin/org.go:67).
    const org = await new OrgService(env.DB).getOrgByUsername("neighbors-org");
    expect(org).not.toBeNull();
    const membership = await new OrgService(env.DB).getMembership(org!.id, neighborId);
    expect(membership?.role).toBe("owner");
    expect(org?.numMembers).toBe(1);
  });

  it("422s name errors with err.Error() (collision included, org.go:68–72)", async () => {
    const collision = await adminSend("/admin/users/neighbor/orgs", jsonAdmin({ username: "root" }));
    expect(collision.status).toBe(422);
    expect(((await collision.json<Record<string, unknown>>())).message).toBe("user already exists [name: root]");

    const reserved = await adminSend("/admin/users/neighbor/orgs", jsonAdmin({ username: "org" }));
    expect(reserved.status).toBe(422);
    expect(((await reserved.json<Record<string, unknown>>())).message).toBe("name is reserved [name: org]");
  });

  it("404s a missing target", async () => {
    const res = await adminSend("/admin/users/ghost/orgs", jsonAdmin({ username: "fresh-org" }));
    expect(res.status).toBe(404);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("user redirect does not exist [name: ghost]");
  });
});

// ---------------------------------------------------------------------------
// POST /admin/users/{username}/rename (adminRenameUser)
// ---------------------------------------------------------------------------

describe("POST /admin/users/{username}/rename (adminRenameUser)", () => {
  it("renames, writes the redirect rule and rewrites repositories.owner_namespace (204)", async () => {
    await seedRepo(neighborId, "neighbor", "kept", "9101");

    const res = await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "Renamed" }));
    expect(res.status).toBe(204);

    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1);
    expect(row[0]?.username).toBe("Renamed");
    expect(row[0]?.usernameLower).toBe("renamed");
    expect(await new OrgService(env.DB).lookupUserRedirect("neighbor")).toBe(neighborId);

    const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "9101")).limit(1);
    expect(repo[0]?.ownerNamespace).toBe("renamed");
  });

  it("no-ops the exact match and flips display case without a redirect (case-only)", async () => {
    expect((await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "neighbor" }))).status).toBe(204);

    const caseOnly = await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "Neighbor" }));
    expect(caseOnly.status).toBe(204);
    expect(await new OrgService(env.DB).lookupUserRedirect("neighbor")).toBeNull();
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).limit(1);
    expect(row[0]?.username).toBe("Neighbor");
    expect(row[0]?.usernameLower).toBe("neighbor");
  });

  it("422s collisions and unusable names; 422s org targets; 404s misses", async () => {
    const collision = await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "cf-gitea-stub" }));
    expect(collision.status).toBe(422);
    expect(((await collision.json<Record<string, unknown>>())).message).toBe(
      "user already exists [name: cf-gitea-stub]",
    );

    const reserved = await adminSend("/admin/users/neighbor/rename", jsonAdmin({ new_username: "org" }));
    expect(reserved.status).toBe(422);
    expect(((await reserved.json<Record<string, unknown>>())).message).toBe("name is reserved [name: org]");

    const org = await new OrgService(env.DB).createOrg({ name: "theorg", ownerId: adminId });
    const orgTarget = await adminSend(`/admin/users/${org.username}/rename`, jsonAdmin({ new_username: "moved" }));
    expect(orgTarget.status).toBe(422);
    expect(((await orgTarget.json<Record<string, unknown>>())).message).toBe(
      "target is an organization but not user",
    );

    const missing = await adminSend("/admin/users/ghost/rename", jsonAdmin({ new_username: "moved" }));
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/users/{username}/repos (adminCreateRepo)
// ---------------------------------------------------------------------------

describe("POST /admin/users/{username}/repos (adminCreateRepo)", () => {
  it("creates a repository owned by the target (201 Repository, owner permissions)", async () => {
    const res = await adminSend(
      "/admin/users/neighbor/repos",
      jsonAdmin({ name: "proj", description: "made by admin", private: true }),
    );
    expect(res.status).toBe(201);
    const body: Record<string, unknown> = await res.json();
    expect(body).toMatchObject({
      name: "proj",
      full_name: "neighbor/proj",
      private: true,
      permissions: { admin: true, push: true, pull: true },
    });
    expect(((body.owner as Record<string, unknown>) ?? {}).login).toBe("neighbor");

    const stored = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, "proj")).limit(1);
    expect(stored[0]?.ownerId).toBe(neighborId);
    expect(stored[0]?.ownerNamespace).toBe("neighbor");
    expect(stored[0]?.visibility).toBe("private");
  });

  it("400s an unknown readme template before touching the database", async () => {
    const res = await adminSend(
      "/admin/users/neighbor/repos",
      jsonAdmin({ name: "proj", auto_init: true, readme: "NoSuch" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json<Record<string, unknown>>())).message).toBe(
      "readme template does not exist, available templates: [Default]",
    );
  });

  it("409s a name collision and 422s an unusable repo name", async () => {
    await seedRepo(neighborId, "neighbor", "taken", "9102");
    const collision = await adminSend("/admin/users/neighbor/repos", jsonAdmin({ name: "taken" }));
    expect(collision.status).toBe(409);
    expect(((await collision.json<Record<string, unknown>>())).message).toBe(
      "The repository with the same name already exists.",
    );

    const invalid = await adminSend("/admin/users/neighbor/repos", jsonAdmin({ name: "held.wiki" }));
    expect(invalid.status).toBe(422);
    expect(((await invalid.json<Record<string, unknown>>())).message).toBe(
      "repository name is not allowed: held.wiki",
    );
  });

  it("404s a missing target", async () => {
    const res = await adminSend("/admin/users/ghost/repos", jsonAdmin({ name: "proj" }));
    expect(res.status).toBe(404);
  });
});

// -----------------------------------------------------------------------------
// Census B-87 — the PASSWORD_CHECK_PWN arm (admin/user.go:113-119 create,
// :220-221 edit; pwn.go:37-51 IsPwned over the HIBP range API). Default OFF
// = no outbound call; armed = the real check with BOTH failure shapes
// mapped (create: PasswordPwned with the request-error logged; edit: the
// raw err.Error() texts).
// -----------------------------------------------------------------------------

describe("the PASSWORD_CHECK_PWN arm (admin/user.go:113-119 / :220-221)", () => {
  /** The HIBP range body for a password whose suffix the stub serves. */
  const pwnedRangeBody = async (password: string, count = 42): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    return `${hex.slice(5)}:${count}`;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("default OFF: no outbound call happens even when fetch would fail (pwn.go:37-39's nil short-circuit)", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network must not be touched with the knob off");
    });
    const res = await adminSend(
      "/admin/users",
      jsonAdmin({ username: "pwnoff", email: "pwnoff@example.com", password: "Sup3r-Secret!" }),
    );
    expect(res.status).toBe(201);
  });

  it("armed + pwned password → 400 PasswordPwned on create (admin/user.go:118)", async () => {
    const send = adminSendKnobs({ PASSWORD_CHECK_PWN: "true" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pwnedRangeBody("Pwned-Secret-1").then((body) => new Response(body, { status: 200 }))),
    );
    const res = await send(
      "/admin/users",
      jsonAdmin({ username: "pwneduser", email: "pwned@example.com", password: "Pwned-Secret-1" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("PasswordPwned");
  });

  it("armed + clean password → 201 (the range miss passes)", async () => {
    const send = adminSendKnobs({ PASSWORD_CHECK_PWN: "true" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("ABCDEF0123456789ABCDEF0123456789ABCDEF01:5\n", { status: 200 }))),
    );
    const res = await send(
      "/admin/users",
      jsonAdmin({ username: "cleanpwn", email: "cleanpwn@example.com", password: "Fresh-And-Clean-1" }),
    );
    expect(res.status).toBe(201);
  });

  it("armed + HIBP request failure → create still answers PasswordPwned with the failure logged (admin/user.go:115-117's log.Error + the same 400)", async () => {
    const send = adminSendKnobs({ PASSWORD_CHECK_PWN: "true" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("upstream exploded", { status: 503 }))),
    );
    const res = await send(
      "/admin/users",
      jsonAdmin({ username: "pwnfail", email: "pwnfail@example.com", password: "Fresh-And-Clean-2" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("PasswordPwned");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("using Have-I-Been-Pwned service failed"));
    errSpy.mockRestore();
  });

  it("armed on the EDIT arm → the raw err.Error() texts at 400 (admin/user.go:220-221)", async () => {
    const send = adminSendKnobs({ PASSWORD_CHECK_PWN: "true" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pwnedRangeBody("Edited-Pwned-Pass").then((body) => new Response(body, { status: 200 }))),
    );
    const hit = await send("/admin/users/neighbor", jsonPatch({ password: "Edited-Pwned-Pass" }));
    expect(hit.status).toBe(400);
    expect(((await hit.json<Record<string, unknown>>())).message).toBe("password has been pwned");

    const failing = adminSendKnobs({ PASSWORD_CHECK_PWN: "true" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("dns timeout"))),
    );
    const miss = await failing("/admin/users/neighbor", jsonPatch({ password: "Edited-Clean-Pass-1" }));
    expect(miss.status).toBe(400);
    expect(((await miss.json<Record<string, unknown>>())).message).toBe(
      "using Have-I-Been-Pwned service failed: dns timeout",
    );
  });
});
