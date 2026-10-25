/**
 * The /tag_protections API family (inventory batch 8), route-level on real
 * D1 (the branch-protections.test.ts standalone-mount convention; the family
 * is pure D1 — no engine cells). The enforcement arms (tags.ts + the gate)
 * have their own files.
 *
 * Matrix: CRUD happy paths with the upstream render shape (ToTagProtection,
 * convert.go:1016-1039), the two create 400s with upstream's exact texts
 * ("name_pattern are empty" quirk included), the 403 duplicate-pattern
 * pre-check, the 404 family (unknown id, FOREIGN-repo id, non-integer id →
 * PathParamInt64(→0)), the 422 unknown user (lowercased name in the error
 * text) and unknown team (org-scoped only), the user-repo silent
 * whitelist_teams drop (create AND edit), the pointer semantics of the edit
 * arm (name_pattern replaced verbatim, absent arrays keep stored ids, teams
 * resolve before usernames), the 423 archived arms (create/edit ONLY —
 * upstream's DELETE arm has no mustNotBeArchived), and the non-admin 403 /
 * anonymous 401 runtime arms.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { protectedTags, repositories, teamMembers, teams } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerTagRoutes } from "./tags";
import { registerTagProtectionRoutes } from "./tag-protections";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["protected_tags", "team_members", "teams", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin, type] of [
    [1, "doer", 0, "user"], // a plain authenticated non-admin
    [2, "bob", 0, "user"],
    [3, "chief", 1, "user"], // site admin
    [4, "alice", 0, "user"], // the repo owner (the family's admin)
    [20, "acme", 0, "org"], // the org owner
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)")
      .bind(id, username, username, isAdmin, type)
      .run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const DOER_TOKEN = "token-doer";
const ALICE_TOKEN = "token-alice";
const CHIEF_TOKEN = "token-chief";

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [ALICE_TOKEN]: { id: 4, login: "alice", is_admin: false },
  [CHIEF_TOKEN]: { id: 3, login: "chief", is_admin: true },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

/** Local mount of the orchestrator's registration seam (requireAuth only —
 *  the whole family is reqToken+reqAdmin upstream). Paths strip the /api/v1
 *  prefix. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerTagProtectionRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

const post = (path: string, body: unknown, token = ALICE_TOKEN): Promise<Response> =>
  router()(path, authed(token, { method: "POST", body: JSON.stringify(body) }));
const patch = (path: string, body: unknown, token = ALICE_TOKEN): Promise<Response> =>
  router()(path, authed(token, { method: "PATCH", body: JSON.stringify(body) }));
const del = (path: string, token = ALICE_TOKEN): Promise<Response> => router()(path, authed(token, { method: "DELETE" }));
const get = (path: string, token = ALICE_TOKEN): Promise<Response> => router()(path, authed(token));

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

let repoSeq = 8300;

async function seedRepo(options: { orgOwned?: boolean; archived?: boolean; slugSuffix?: string } = {}): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `tagp${repoId}${options.slugSuffix ?? ""}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: options.orgOwned === true ? "acme" : "alice",
    ownerId: options.orgOwned === true ? 20 : 4,
    slug,
    visibility: "public",
    isArchived: options.archived === true,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(repoId);
  return { slug, repoId };
}

/** The org's team `devs` with bob as the member. */
async function seedTeam(name = "devs", memberIds: number[] = []): Promise<number> {
  const inserted = await db()
    .insert(teams)
    .values({ orgId: 20, lowerName: name, name, authorize: "write" })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  for (const userId of memberIds) {
    await db().insert(teamMembers).values({ orgId: 20, teamId, userId });
  }
  return teamId;
}

async function storedRow(repoId: string): Promise<{ id: number; namePattern: string; users: number[]; teams: number[] }> {
  const raw = await db().select().from(protectedTags).where(eq(protectedTags.repoId, repoId)).all();
  const row = raw[0]!;
  return { id: row.id, namePattern: row.namePattern, users: JSON.parse(row.allowlistUserIds) as number[], teams: JSON.parse(row.allowlistTeamIds) as number[] };
}

// ---------------------------------------------------------------------------
// List + auth arms.
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/tag_protections (repoListTagProtection)", () => {
  it("lists every rule with the ToTagProtection render shape", async () => {
    const { slug } = await seedRepo({ orgOwned: true });
    await seedTeam("devs", [2]);
    expect(await get(`/api/v1/repos/acme/${slug}/tag_protections`, CHIEF_TOKEN)).toMatchObject({ status: 200 });
    expect(await jsonBody(await get(`/api/v1/repos/acme/${slug}/tag_protections`, CHIEF_TOKEN))).toEqual([]);

    // the acme repo's admin is the site admin (alice owns only her own repos)
    const created = await post(
      `/api/v1/repos/acme/${slug}/tag_protections`,
      { name_pattern: "release-*", whitelist_usernames: ["bob", "ALICE"], whitelist_teams: ["devs"] },
      CHIEF_TOKEN,
    );
    expect(created.status).toBe(201);
    const body = await jsonBody(created);
    expect(body).toMatchObject({
      name_pattern: "release-*",
      whitelist_usernames: ["bob", "alice"],
      whitelist_teams: ["devs"],
    });
    expect(typeof body.id).toBe("number");
    expect(typeof body.created_at).toBe("string");
    expect(typeof body.updated_at).toBe("string");

    const list = (await jsonBody(await get(`/api/v1/repos/acme/${slug}/tag_protections`, CHIEF_TOKEN))) as unknown as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject(body);
  });

  it("401s anonymous, 403s a non-admin reader (runtime arms)", async () => {
    const { slug } = await seedRepo();
    const anon = await router()(`/api/v1/repos/alice/${slug}/tag_protections`);
    expect(anon.status).toBe(401);
    expect((await get(`/api/v1/repos/alice/${slug}/tag_protections`, DOER_TOKEN)).status).toBe(403);
    expect((await get(`/api/v1/repos/alice/${slug}/tag_protections`, CHIEF_TOKEN)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/tag_protections (repoCreateTagProtection)", () => {
  it("trims the pattern, resolves case-insensitively, and stores the allowlists", async () => {
    const { slug, repoId } = await seedRepo({ orgOwned: true });
    const teamId = await seedTeam("devs", [2]);
    const created = await post(
      `/api/v1/repos/acme/${slug}/tag_protections`,
      {
        name_pattern: "  v*.*  ",
        whitelist_usernames: ["BOB"],
        whitelist_teams: ["DEVS"],
      },
      CHIEF_TOKEN,
    );
    expect(created.status).toBe(201);
    const row = await storedRow(repoId);
    expect(row.namePattern).toBe("v*.*");
    expect(row.users).toEqual([2]);
    expect(row.teams).toEqual([teamId]);
  });

  it("400s on the two empty arms with upstream's exact texts", async () => {
    const { slug } = await seedRepo();
    const noPattern = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "   ", whitelist_usernames: ["bob"] });
    expect(noPattern.status).toBe(400);
    expect(await jsonBody(noPattern)).toMatchObject({ message: "name_pattern are empty" });

    const noLists = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v*" });
    expect(noLists.status).toBe(400);
    expect(await jsonBody(noLists)).toMatchObject({ message: "both whitelist_usernames and whitelist_teams are empty" });
  });

  it("403s on the exact-pattern duplicate (trimmed), 201s a different pattern", async () => {
    const { slug } = await seedRepo();
    expect((await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] })).status).toBe(201);
    const dup = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: " v* ", whitelist_usernames: ["alice"] });
    expect(dup.status).toBe(403);
    expect(await jsonBody(dup)).toMatchObject({ message: "Tag protection already exist" });
    expect((await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v2*", whitelist_usernames: ["alice"] })).status).toBe(201);
  });

  it("422s on an unknown username with the lowercased-name error text; org names never resolve as users", async () => {
    const { slug } = await seedRepo();
    const unknown = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["NoBody"] });
    expect(unknown.status).toBe(422);
    expect(await jsonBody(unknown)).toMatchObject({ message: "user does not exist [uid: 0, name: nobody]" });

    const org = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["acme"] });
    expect(org.status).toBe(422);
    expect(await jsonBody(org)).toMatchObject({ message: "user does not exist [uid: 0, name: acme]" });
  });

  it("422s on an unknown team on an org repo; silently DROPS whitelist_teams on a user repo", async () => {
    const orgRepo = await seedRepo({ orgOwned: true });
    const teamFail = await post(
      `/api/v1/repos/acme/${orgRepo.slug}/tag_protections`,
      { name_pattern: "v*", whitelist_usernames: ["bob"], whitelist_teams: ["ghosts"] },
      CHIEF_TOKEN,
    );
    expect(teamFail.status).toBe(422);
    expect(await jsonBody(teamFail)).toMatchObject({ message: `team does not exist [org_id 20, team_id 0, name: ghosts]` });

    const userRepo = await seedRepo();
    const dropped = await post(`/api/v1/repos/alice/${userRepo.slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"], whitelist_teams: ["devs"] });
    expect(dropped.status).toBe(201); // no error — upstream never resolves teams off an org owner
    const row = await storedRow(userRepo.repoId);
    expect(row.teams).toEqual([]);
    expect((await jsonBody(dropped)).whitelist_teams).toEqual([]);
  });

  it("423s on an archived repo", async () => {
    const { slug } = await seedRepo({ archived: true });
    const res = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] });
    expect(res.status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// Get.
// ---------------------------------------------------------------------------

describe("GET .../tag_protections/{id} (repoGetTagProtection)", () => {
  it("200s the row, 404s an unknown id, a FOREIGN-repo id, and a non-integer id", async () => {
    const mine = await seedRepo();
    const other = await seedRepo({ slugSuffix: "x" });
    const created = await post(`/api/v1/repos/alice/${mine.slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] });
    const id = ((await jsonBody(created)) as { id: number }).id;

    const ok = await get(`/api/v1/repos/alice/${mine.slug}/tag_protections/${id}`);
    expect(ok.status).toBe(200);
    expect(await jsonBody(ok)).toMatchObject({ id, name_pattern: "v*", whitelist_usernames: ["bob"] });

    expect((await get(`/api/v1/repos/alice/${mine.slug}/tag_protections/999999`)).status).toBe(404);
    // the foreign-repo id is the same plain 404 (tag.go:348-351)
    expect((await get(`/api/v1/repos/alice/${other.slug}/tag_protections/${id}`)).status).toBe(404);
    // PathParamInt64(→0) → miss (base_path.go:35)
    expect((await get(`/api/v1/repos/alice/${mine.slug}/tag_protections/notanumber`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Edit.
// ---------------------------------------------------------------------------

describe("PATCH .../tag_protections/{id} (repoEditTagProtection)", () => {
  it("replaces name_pattern verbatim (no trim) and only the arrays that are present", async () => {
    const { slug, repoId } = await seedRepo({ orgOwned: true });
    const teamId = await seedTeam("devs", [2]);
    const created = await post(
      `/api/v1/repos/acme/${slug}/tag_protections`,
      { name_pattern: "v*", whitelist_usernames: ["bob"], whitelist_teams: ["devs"] },
      CHIEF_TOKEN,
    );
    const id = ((await jsonBody(created)) as { id: number }).id;

    const edited = await patch(
      `/api/v1/repos/acme/${slug}/tag_protections/${id}`,
      { name_pattern: "  keep-my-spaces  ", whitelist_usernames: ["alice"] },
      CHIEF_TOKEN,
    );
    expect(edited.status).toBe(200);
    const body = await jsonBody(edited);
    expect(body).toMatchObject({ name_pattern: "  keep-my-spaces  ", whitelist_usernames: ["alice"], whitelist_teams: ["devs"] });

    const row = await storedRow(repoId);
    expect(row.namePattern).toBe("  keep-my-spaces  ");
    expect(row.users).toEqual([4]);
    expect(row.teams).toEqual([teamId]); // absent teams array kept the stored ids
  });

  it("a present-but-empty array REPLACES (the plain-slice semantics); user-repo teams empty out silently", async () => {
    const { slug, repoId } = await seedRepo({ orgOwned: true });
    const created = await post(`/api/v1/repos/acme/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] }, CHIEF_TOKEN);
    const id = ((await jsonBody(created)) as { id: number }).id;
    const emptied = await patch(`/api/v1/repos/acme/${slug}/tag_protections/${id}`, { whitelist_usernames: [] }, CHIEF_TOKEN);
    expect(emptied.status).toBe(200);
    expect(await jsonBody(emptied)).toMatchObject({ whitelist_usernames: [] });
    expect((await storedRow(repoId)).users).toEqual([]);

    const userRepo = await seedRepo();
    const created2 = await post(`/api/v1/repos/alice/${userRepo.slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] });
    const id2 = ((await jsonBody(created2)) as { id: number }).id;
    // a teams array on a USER repo: resolved as [] (GetTeamIDsByNames never runs)
    const teamsDropped = await patch(`/api/v1/repos/alice/${userRepo.slug}/tag_protections/${id2}`, { whitelist_teams: ["devs"] });
    expect(teamsDropped.status).toBe(200);
    expect(await jsonBody(teamsDropped)).toMatchObject({ whitelist_teams: [] });
    expect((await storedRow(userRepo.repoId)).teams).toEqual([]);
  });

  it("422s on the team arm FIRST (upstream resolves teams before usernames)", async () => {
    const { slug } = await seedRepo({ orgOwned: true });
    const created = await post(`/api/v1/repos/acme/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] }, CHIEF_TOKEN);
    const id = ((await jsonBody(created)) as { id: number }).id;
    const res = await patch(
      `/api/v1/repos/acme/${slug}/tag_protections/${id}`,
      { whitelist_teams: ["ghosts"], whitelist_usernames: ["nobody"] },
      CHIEF_TOKEN,
    );
    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toMatchObject({ message: `team does not exist [org_id 20, team_id 0, name: ghosts]` });
  });

  it("404s unknown/foreign ids, 423s archived", async () => {
    const { slug } = await seedRepo();
    const archived = await seedRepo({ archived: true, slugSuffix: "arc" });
    expect((await patch(`/api/v1/repos/alice/${slug}/tag_protections/424242`, { name_pattern: "x*" })).status).toBe(404);
    expect((await patch(`/api/v1/repos/alice/${archived.slug}/tag_protections/1`, {})).status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// The tags.ts enforcement wiring (this wave's insertion): an API tag
// create/delete on a protected tag 422s with upstream's exact texts
// (routers/api/v1/repo/tag.go:224-227 / :282-285); the allowlisted caller
// goes through.
// ---------------------------------------------------------------------------

/** Worker-side object hash (the push-stale.test.ts convention). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** seedRepo + a real commit at refs/heads/main in the engine cell, so the
 *  tags routes' target resolution and empty-repo arm pass through to the
 *  enforcement check. */
async function seedRepoWithMain(): Promise<{ slug: string; repoId: string }> {
  const seeded = await seedRepo();
  const cell = env.REPO.getByName(`alice/${seeded.slug}`);
  const person = { name: "seed", email: "seed@tagp.invalid", time: 1761000000, tz: "+0000" };
  const readme = new TextEncoder().encode("# tagp\n");
  const readmeOid = await gitObjectOid("blob", readme);
  const tree = serializeTree([{ mode: "100644", name: "README.md", oid: readmeOid }]);
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "root\n" });
  const put = await cell.putApiObjects([
    { oid: readmeOid, type: "blob", data: readme },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  expect(put.tag).toBe("ok");
  const landed = await cell.commitApiChange({ ref: "refs/heads/main", expectedOldOid: "0".repeat(40), newOid: commit.oid });
  expect(landed.tag).toBe("committed");
  await db().update(repositories).set({ isEmpty: false }).where(eq(repositories.id, seeded.repoId));
  return { slug: seeded.slug, repoId: seeded.repoId };
}

/** The dual mount: the protection family + the tags family it enforces. */
function dualRouter() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerTagProtectionRoutes(app, createTokenAuthMiddleware(resolver));
  registerTagRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const dualFetch = (path: string, init?: RequestInit): Promise<Response> => dualRouter()(path, authed(ALICE_TOKEN, init));

describe("tags.ts enforcement wiring (IsUserAllowedToControlTag at the API tag create/delete arms)", () => {
  it("POST /tags on a protected tag 422s with upstream's text; the allowlisted owner's tag lands", async () => {
    const { slug } = await seedRepoWithMain();
    const created = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "secure-*", whitelist_usernames: ["bob"] });
    const protectionId = ((await jsonBody(created)) as { id: number }).id;

    const denied = await dualFetch(`/api/v1/repos/alice/${slug}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_name: "secure-1" }),
    });
    expect(denied.status).toBe(422);
    expect(await jsonBody(denied)).toMatchObject({ message: "user not allowed to create protected tag" });

    // allowlisting the caller lets the same create through (and it lands at
    // the seeded commit — a lightweight tag)
    await patch(`/api/v1/repos/alice/${slug}/tag_protections/${protectionId}`, { whitelist_usernames: ["alice"] });
    const allowed = await dualFetch(`/api/v1/repos/alice/${slug}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_name: "secure-2" }),
    });
    expect(allowed.status).toBe(200);

    // an UNPROTECTED tag never consults the rule
    const unrelated = await dualFetch(`/api/v1/repos/alice/${slug}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_name: "free-1" }),
    });
    expect(unrelated.status).toBe(200);
  });
  it("DELETE /tags/{tag} on a protected tag 422s with upstream's text; the allowlisted owner's delete lands", async () => {
    const { slug } = await seedRepoWithMain();
    const created = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "secure-*", whitelist_usernames: ["bob"] });
    const protectionId = ((await jsonBody(created)) as { id: number }).id;

    // stage the tag while allowlisted
    await patch(`/api/v1/repos/alice/${slug}/tag_protections/${protectionId}`, { whitelist_usernames: ["alice"] });
    const staged = await dualFetch(`/api/v1/repos/alice/${slug}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_name: "secure-1" }),
    });
    expect(staged.status).toBe(200);

    // strip the allowlist: the delete 422s with upstream's exact text
    await patch(`/api/v1/repos/alice/${slug}/tag_protections/${protectionId}`, { whitelist_usernames: [] });
    const denied = await dualFetch(`/api/v1/repos/alice/${slug}/tags/secure-1`, { method: "DELETE" });
    expect(denied.status).toBe(422);
    expect(await jsonBody(denied)).toMatchObject({ message: "user not allowed to delete protected tag" });

    // re-allow: the delete goes through
    await patch(`/api/v1/repos/alice/${slug}/tag_protections/${protectionId}`, { whitelist_usernames: ["alice"] });
    const allowed = await dualFetch(`/api/v1/repos/alice/${slug}/tags/secure-1`, { method: "DELETE" });
    expect(allowed.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Delete.
// ---------------------------------------------------------------------------

describe("DELETE .../tag_protections/{id} (repoDeleteTagProtection)", () => {
  it("204s and removes the row; 404s unknown; the ARCHIVED repo still deletes (no mustNotBeArchived on upstream's DELETE arm)", async () => {
    const { slug, repoId } = await seedRepo();
    const created = await post(`/api/v1/repos/alice/${slug}/tag_protections`, { name_pattern: "v*", whitelist_usernames: ["bob"] });
    const id = ((await jsonBody(created)) as { id: number }).id;
    expect((await del(`/api/v1/repos/alice/${slug}/tag_protections/${id}`)).status).toBe(204);
    expect(await db().select().from(protectedTags).where(eq(protectedTags.repoId, repoId)).all()).toHaveLength(0);
    expect((await del(`/api/v1/repos/alice/${slug}/tag_protections/${id}`)).status).toBe(404);

    // The DELETE arm itself is not archived-gated (upstream api.go:1344-1345
    // carries no mustNotBeArchived there) — the row is seeded directly
    // because the CREATE arm 423s on an archived repo.
    const archived = await seedRepo({ archived: true, slugSuffix: "arc" });
    const now = new Date();
    const seeded = await db()
      .insert(protectedTags)
      .values({
        repoId: archived.repoId,
        namePattern: "v*",
        allowlistUserIds: "[2]",
        allowlistTeamIds: "[]",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: protectedTags.id })
      .all();
    expect((await del(`/api/v1/repos/alice/${archived.slug}/tag_protections/${seeded[0]!.id}`)).status).toBe(204);
  });
});
