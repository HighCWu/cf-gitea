/**
 * Tier-2 org-label routes (routes/labels-t2.ts) on real D1: the orgLabel
 * family — orgListLabels / orgCreateLabel / orgGetLabel / orgEditLabel /
 * orgDeleteLabel (gitea/routers/api/v1/org/label.go over api.go:1758–1764).
 * The repo-label and issue-label halves live in labels.test.ts /
 * issues.test.ts / issue-write-t2.test.ts.
 *
 * Standalone mount (the issue-write-t2.test.ts convention): the register
 * function takes the requireAuth/optionalAuth pair and is mounted on a fresh
 * OpenAPIHono with the real auth middlewares, the stub resolver mapping
 * `token u<id>` to the seeded D1 user rows, so the org_members-backed owner
 * gates are exercisable against the same rows the guards query.
 *
 * The behavior pins asserted here (plain "not found" 404s, the silent sort
 * param, anonymous list vs reqToken'd id read, the owner-only writes, the
 * 204-on-missing delete, the is_archived create quirk and tri-state patch)
 * are cited in the route/service module headers (org/label.go,
 * models/issues/label.go, services/convert/issue.go).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, issueLabels, labels, repositories, users } from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerLabelsT2Routes } from "./labels-t2";
import { IssuesService } from "../../issues/service";
import { createOrgLabel } from "../services/labels-t2";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";

beforeAll(applyOrgsDdl);

beforeEach(async () => {
  // The label-family tables first, then the org sweep (repositories,
  // users-without-the-reserved-'assets'-row, org_members, redirects).
  for (const table of ["comments", "issue_labels", "issues", "labels"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await resetOrgTables();
  seededUsers.clear();
});

const db = () => drizzle(env.DB);
const ERROR_URL = "https://example.com/api/swagger";

/** Seeded D1 users the test resolver authenticates as (`token u<id>`). */
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
  registerLabelsT2Routes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface LabelsSeed {
  owner: SeededUser;
  member: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
  plainUser: SeededUser;
  org: OrgRecord;
  privateOrg: OrgRecord;
}

/** Owner + member + outsider + site admin + a plain (non-org) user, a public
 *  and a private org (owner + member in each). */
async function seedActors(): Promise<LabelsSeed> {
  const owner = await seedUser("org-owner");
  const member = await seedUser("org-member");
  const outsider = await seedUser("outsider");
  const admin = await seedUser("site-admin", true);
  const plainUser = await seedUser("plain-user");
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
  await orgs.addMember(org.id, member.id);
  const privateOrg = await orgs.createOrg({ name: "secret", ownerId: owner.id, visibility: "private" });
  await orgs.addMember(privateOrg.id, member.id);
  return { owner, member, outsider, admin, plainUser, org, privateOrg };
}

/** A fresh org label (the service seam the create route drives). */
async function seedOrgLabel(org: OrgRecord, name: string, color = "#00aabb") {
  return createOrgLabel(env.DB, org.id, { name, exclusive: false, color, description: "" });
}

// ---------------------------------------------------------------------------
// orgListLabels
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/labels (orgListLabels)", () => {
  it("lists only the org's own labels, name ASC, with org URLs and the total header", async () => {
    const actors = await seedActors();
    const bug = await seedOrgLabel(actors.org, "bug", "#ee0701");
    const enhancement = await seedOrgLabel(actors.org, "enhancement", "#84b6eb");
    // Noise: another org's label and a repo-scoped label never leak in.
    await seedOrgLabel(actors.privateOrg, "other-org");
    await db()
      .insert(labels)
      .values({ repoId: "9001", orgId: 0, name: "repo-label", exclusive: false, color: "#123123", description: "" });

    const send = router();
    const res = await send(`/orgs/${actors.org.username}/labels`, { headers: authHeaders(actors.owner.id) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toEqual([
      {
        id: bug.id,
        name: "bug",
        exclusive: false,
        is_archived: false,
        color: "ee0701",
        description: "",
        url: `https://example.com/api/v1/orgs/acme/labels/${bug.id}`,
      },
      {
        id: enhancement.id,
        name: "enhancement",
        exclusive: false,
        is_archived: false,
        color: "84b6eb",
        description: "",
        url: `https://example.com/api/v1/orgs/acme/labels/${enhancement.id}`,
      },
    ]);
  });

  it("honors the undeclared sort param and paginates with the unpaginated total", async () => {
    const actors = await seedActors();
    for (const name of ["a", "b", "c"]) {
      await seedOrgLabel(actors.org, name);
    }
    const send = router();

    const reversed = await send(`/orgs/${actors.org.username}/labels?sort=reversealphabetically`, {
      headers: authHeaders(actors.owner.id),
    });
    expect((await reversed.json<Array<{ name: string }>>()).map((row) => row.name)).toEqual(["c", "b", "a"]);

    const page = await send(`/orgs/${actors.org.username}/labels?page=2&limit=2`, {
      headers: authHeaders(actors.owner.id),
    });
    expect(page.headers.get("x-total-count")).toBe("3");
    expect((await page.json<Array<unknown>>())).toHaveLength(1);
  });

  it("is anonymous-capable on a visible org; misses are the shared 404 (missing, plain user, invisible org)", async () => {
    const actors = await seedActors();
    const send = router();

    // No reqToken on the list (api.go:1759) — anonymous reads a public org.
    expect((await send(`/orgs/${actors.org.username}/labels`)).status).toBe(200);

    expect((await send("/orgs/ghost-org/labels")).status).toBe(404);
    // The §4.11 type filter: a plain user under /orgs is a 404-shaped miss.
    expect((await send(`/orgs/${actors.plainUser.username}/labels`)).status).toBe(404);
    // reqOrgVisible: a private org is invisible to outsiders, visible to members.
    expect((await send(`/orgs/${actors.privateOrg.username}/labels`)).status).toBe(404);
    expect(
      (await send(`/orgs/${actors.privateOrg.username}/labels`, { headers: authHeaders(actors.member.id) })).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// orgCreateLabel
// ---------------------------------------------------------------------------

describe("POST /orgs/{org}/labels (orgCreateLabel)", () => {
  it("creates as the org owner (201) — org-scoped row, `is_archived` ignored (upstream quirk)", async () => {
    const actors = await seedActors();
    const send = router();
    const res = await send(`/orgs/${actors.org.username}/labels`, {
      method: "POST",
      headers: authHeaders(actors.owner.id),
      body: JSON.stringify({
        name: "needs-review",
        color: "#00AABB",
        description: "needs a review",
        exclusive: true,
        is_archived: true, // org/label.go:97–103 never applies it — mirrored
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    const row = await db().select().from(labels).where(eq(labels.id, body.id as number)).limit(1).then((rows) => rows[0]);
    expect(row).toMatchObject({
      repoId: null,
      orgId: actors.org.id,
      name: "needs-review",
      exclusive: true,
      color: "#00aabb",
      description: "needs a review",
      archivedAt: null,
    });
    expect(body).toMatchObject({
      name: "needs-review",
      color: "00aabb",
      description: "needs a review",
      exclusive: true,
      is_archived: false,
      url: `https://example.com/api/v1/orgs/acme/labels/${String(body.id)}`,
    });
  });

  it("gates writes on org ownership (403, the exact message) with the admin bypass", async () => {
    const actors = await seedActors();
    const send = router();
    const body = JSON.stringify({ name: "x", color: "#00aabb" });

    const memberRes = await send(`/orgs/${actors.org.username}/labels`, {
      method: "POST",
      headers: authHeaders(actors.member.id),
      body,
    });
    expect(memberRes.status).toBe(403);
    expect((await memberRes.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");

    // An outsider on a PUBLIC org passes reqOrgVisible and fails ownership.
    expect(
      (await send(`/orgs/${actors.org.username}/labels`, { method: "POST", headers: authHeaders(actors.outsider.id), body }))
        .status,
    ).toBe(403);

    // Site admins bypass reqOrgOwnership (api.go:428–430).
    expect(
      (await send(`/orgs/${actors.org.username}/labels`, { method: "POST", headers: authHeaders(actors.admin.id), body }))
        .status,
    ).toBe(201);
  });

  it("422s an invalid color with the normalized string (after the org guards)", async () => {
    const actors = await seedActors();
    const send = router();
    const res = await send(`/orgs/${actors.org.username}/labels`, {
      method: "POST",
      headers: authHeaders(actors.owner.id),
      body: JSON.stringify({ name: "x", color: " red " }),
    });
    expect(res.status).toBe(422);
    // " red " trims to "red", which is 3 chars, so the normalizer prepends
    // the '#' before failing — the exact upstream NormalizeColor behavior
    // (modules/label/label.go:29–41, the message carries the normalized form).
    expect((await res.json<Record<string, unknown>>()).message).toBe("invalid color: #red");
  });

  it("404s missing orgs and plain users; anonymous is the runtime-only 401", async () => {
    const actors = await seedActors();
    const send = router();
    const body = JSON.stringify({ name: "x", color: "#00aabb" });
    expect((await send("/orgs/ghost-org/labels", { method: "POST", headers: authHeaders(actors.owner.id), body })).status).toBe(404);
    expect(
      (
        await send(`/orgs/${actors.plainUser.username}/labels`, {
          method: "POST",
          headers: authHeaders(actors.owner.id),
          body,
        })
      ).status,
    ).toBe(404);
    const anon = await send(`/orgs/${actors.org.username}/labels`, { method: "POST", body });
    expect(anon.status).toBe(401);
    expect((await anon.json<Record<string, unknown>>()).url).toBe(ERROR_URL);
  });
});

// ---------------------------------------------------------------------------
// orgGetLabel
// ---------------------------------------------------------------------------

describe("GET /orgs/{org}/labels/{id} (orgGetLabel)", () => {
  it("resolves by numeric id and by exact-case name; wrong case is the plain 404", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "Bug");
    const send = router();

    const byId = await send(`/orgs/${actors.org.username}/labels/${label.id}`, { headers: authHeaders(actors.owner.id) });
    expect(byId.status).toBe(200);
    expect((await byId.json<Record<string, unknown>>()).name).toBe("Bug");

    const byName = await send(`/orgs/${actors.org.username}/labels/Bug`, { headers: authHeaders(actors.owner.id) });
    expect(byName.status).toBe(200);

    const wrongCase = await send(`/orgs/${actors.org.username}/labels/bug`, { headers: authHeaders(actors.owner.id) });
    expect(wrongCase.status).toBe(404);
    expect((await wrongCase.json<Record<string, unknown>>()).message).toBe("not found");
  });

  it("keeps org scoping: foreign org labels and repo labels are the indistinguishable 404", async () => {
    const actors = await seedActors();
    const foreign = await seedOrgLabel(actors.privateOrg, "foreign");
    const repoLabel = await db()
      .insert(labels)
      .values({ repoId: "9001", orgId: 0, name: "repo-label", exclusive: false, color: "#123123", description: "" })
      .returning()
      .then((rows) => rows[0]!);
    const send = router();
    for (const id of [foreign.id, repoLabel.id, "0", "not-an-id"]) {
      const res = await send(`/orgs/${actors.org.username}/labels/${id}`, { headers: authHeaders(actors.owner.id) });
      expect(res.status).toBe(404);
      expect((await res.json<Record<string, unknown>>()).message).toBe("not found");
    }
  });

  it("requires a token (upstream reqToken on the combo — runtime-only 401) and honors reqOrgVisible", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.privateOrg, "hidden");
    const send = router();
    expect((await send(`/orgs/${actors.privateOrg.username}/labels/${label.id}`)).status).toBe(401);
    expect(
      (await send(`/orgs/${actors.privateOrg.username}/labels/${label.id}`, { headers: authHeaders(actors.member.id) }))
        .status,
    ).toBe(200);
    expect(
      (await send(`/orgs/${actors.privateOrg.username}/labels/${label.id}`, { headers: authHeaders(actors.outsider.id) }))
        .status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// orgEditLabel
// ---------------------------------------------------------------------------

describe("PATCH /orgs/{org}/labels/{id} (orgEditLabel)", () => {
  it("patches only the presented fields (200) and persists them", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "old-name", "#00aabb");
    const send = router();
    const res = await send(`/orgs/${actors.org.username}/labels/${label.id}`, {
      method: "PATCH",
      headers: authHeaders(actors.owner.id),
      body: JSON.stringify({ name: "new-name", color: "#BBCCDD", description: "updated", exclusive: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id: label.id, name: "new-name", color: "bbccdd", description: "updated", exclusive: true });
    const row = await db().select().from(labels).where(eq(labels.id, label.id)).limit(1).then((rows) => rows[0]);
    expect(row).toMatchObject({ name: "new-name", color: "#bbccdd", description: "updated", exclusive: true });
  });

  it("is_archived tri-state: explicit true stamps, explicit false clears, absent keeps", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "archive-me");
    const send = router();
    const patch = (body: Record<string, unknown>) =>
      send(`/orgs/${actors.org.username}/labels/${label.id}`, {
        method: "PATCH",
        headers: authHeaders(actors.owner.id),
        body: JSON.stringify(body),
      });

    expect((await patch({ is_archived: true })).status).toBe(200);
    let row = await db().select().from(labels).where(eq(labels.id, label.id)).limit(1).then((rows) => rows[0]);
    expect(row?.archivedAt).not.toBeNull();

    // Absent keeps the stamp (shared editRepoLabel — the repo family's
    // documented deviation vs literal upstream SetArchived(false)).
    expect((await patch({ name: "renamed" })).status).toBe(200);
    row = await db().select().from(labels).where(eq(labels.id, label.id)).limit(1).then((rows) => rows[0]);
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.name).toBe("renamed");

    expect((await patch({ is_archived: false })).status).toBe(200);
    row = await db().select().from(labels).where(eq(labels.id, label.id)).limit(1).then((rows) => rows[0]);
    expect(row?.archivedAt).toBeNull();
  });

  it("orders the label 404 before the color 422 (upstream handler order); garbage ids are 404", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "x");
    const send = router();
    const badColor = JSON.stringify({ color: "nope" });

    const missing = await send(`/orgs/${actors.org.username}/labels/99999`, {
      method: "PATCH",
      headers: authHeaders(actors.owner.id),
      body: badColor,
    });
    expect(missing.status).toBe(404);

    const present = await send(`/orgs/${actors.org.username}/labels/${label.id}`, {
      method: "PATCH",
      headers: authHeaders(actors.owner.id),
      body: badColor,
    });
    expect(present.status).toBe(422);
    expect((await present.json<Record<string, unknown>>()).message).toBe("invalid color: nope");

    expect(
      (
        await send(`/orgs/${actors.org.username}/labels/${label.name}`, {
          method: "PATCH",
          headers: authHeaders(actors.owner.id),
          body: JSON.stringify({ name: "y" }),
        })
      ).status,
    ).toBe(404);
  });

  it("gates on org ownership (403) — plain members and outsiders alike", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "gated");
    const send = router();
    for (const actor of [actors.member, actors.outsider]) {
      const res = await send(`/orgs/${actors.org.username}/labels/${label.id}`, {
        method: "PATCH",
        headers: authHeaders(actor.id),
        body: JSON.stringify({ name: "nope" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");
    }
  });
});

// ---------------------------------------------------------------------------
// orgDeleteLabel
// ---------------------------------------------------------------------------

describe("DELETE /orgs/{org}/labels/{id} (orgDeleteLabel)", () => {
  it("deletes the row and cascades the issue links + label comments (204)", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "doomed");
    // An org-owned repo with an issue carrying the label, so the
    // deleteLabel cascade (issue_links, label system comments, row) has
    // real rows to clear (models/issues/label.go:282–298).
    await db().insert(repositories).values({
      id: "9001",
      storageKey: "r_9001",
      ownerNamespace: actors.org.username,
      ownerId: actors.org.id,
      slug: "widgets",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const issue = await new IssuesService(env.DB).createIssue({
      repoId: "9001",
      title: "labeled",
      content: "",
      posterId: actors.owner.id,
    });
    await new IssuesService(env.DB).setLabel(issue.id, label.id, { ownerOrgId: actors.org.id });

    const send = router();
    const res = await send(`/orgs/${actors.org.username}/labels/${label.id}`, {
      method: "DELETE",
      headers: authHeaders(actors.owner.id),
    });
    expect(res.status).toBe(204);
    expect(await db().select().from(labels).where(eq(labels.id, label.id))).toHaveLength(0);
    expect(await db().select().from(issueLabels).where(eq(issueLabels.labelId, label.id))).toHaveLength(0);
    expect(await db().select().from(comments).where(eq(comments.labelId, label.id))).toHaveLength(0);
  });

  it("answers 204 for a missing label (DeleteOrgLabel deletes zero rows without error) and gates on ownership", async () => {
    const actors = await seedActors();
    const label = await seedOrgLabel(actors.org, "kept");
    const send = router();

    expect(
      (await send(`/orgs/${actors.org.username}/labels/${label.id}`, { method: "DELETE", headers: authHeaders(actors.owner.id) }))
        .status,
    ).toBe(204);
    expect((await send(`/orgs/${actors.org.username}/labels/99999`, { method: "DELETE", headers: authHeaders(actors.owner.id) })).status)
      .toBe(204);

    const memberRes = await send(`/orgs/${actors.org.username}/labels/99999`, {
      method: "DELETE",
      headers: authHeaders(actors.member.id),
    });
    expect(memberRes.status).toBe(403);
    expect((await memberRes.json<Record<string, unknown>>()).message).toBe("Must be an organization owner");
  });
});

// ---------------------------------------------------------------------------
// The orgAssignment 307 seam (shared with the orgs.ts family)
// ---------------------------------------------------------------------------

describe("renamed-org redirect", () => {
  it("answers every labels op on the old name with the 307 path rewrite", async () => {
    const actors = await seedActors();
    await seedOrgLabel(actors.org, "survives");
    const renamed = await new OrgService(env.DB).renameOrg(actors.org.id, "renamed-acme");
    expect(renamed.username).toBe("renamed-acme");
    const send = router();

    const res = await send("/orgs/acme/labels?page=3", { headers: authHeaders(actors.owner.id) });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/orgs/renamed-acme/labels?page=3");
  });
});
