/**
 * The actions secrets/variables/runners + runs/jobs-listing families
 * (routes/secrets-variables.ts — the inventory's `wave-api-secrets-variables`
 * batch extended by P1-7's 15 runner-management ops and P1-8's 6 runs/jobs
 * listing ops) on real D1 (migration 0021's `secrets` + `action_variables` +
 * the SPEC-0012 control-plane store's `action_runners`/`action_runs`/
 * `action_run_jobs`): all 44 contract ops over the standalone-mount
 * convention (the routes ARE registered in router.ts by the orchestrator
 * after this batch).
 *
 * Per-arm contract verification: every DECLARED response code of every op is
 * exercised — secrets list {200,404}, secret PUT {201,204,400,404}, secret
 * DELETE {204,400,404}, variables list/get {200,400,404}, variable create
 * {201,400,409} (+ the repo/org arms' 500), variable PUT {201,204,400,404},
 * variable DELETE {200,201,204,400,404} (the user arm without the 200);
 * runners list/get {200,400,404}, token {200}, delete {204,400,404}, patch
 * {200,400,404,422}; runs list {200,400,404} (the 400 = the invalid-status
 * word, the 404 = the actor miss and the invisible repo), jobs list
 * {200,400,404,422} (the 422 = the sort/order resolution). The
 * declared-but-unreachable arms (the reads' 400, the dead 201/200 leftovers)
 * are pinned by the `⊆ contract` check (pnpm check:api), not runtime — the
 * module header documents each. The RUNTIME-ONLY codes stay undeclared per
 * the module header and are asserted as behavior: 401 (anonymous), the repo
 * arm's reqOwner 403, the org arm's reqOrgOwnership 403 — and, for the
 * runs/jobs pair, the DIFFERENT gate set: repo READER (any authed viewer of
 * a public repo lists; an invisible repo 404s anti-enumerated) and org
 * MEMBERSHIP ("Must be an organization member"), the Go binder's 422
 * Required texts, and the runner family's two 404 shapes (the not-exist text
 * vs EditableInContext's "No permission…" foreign-scope text).
 *
 * The scope encoding is pinned end-to-end: a repo row carries owner_id=0 +
 * the TEXT repo id, an owner row carries the int owner + repo_id='' — lists
 * in one scope never leak rows from another, names are stored UPPERCASE and
 * matched case-insensitively, variable values are EOL-normalized, secret
 * data never renders. The runner status matrix (active/idle/offline) is
 * pinned against runner.go's 60 s/10 s windows with seeded timestamps. The
 * runs/jobs listings are pinned against shared/action.go's semantics: the
 * status-word matrix (convertToInternal + ToRunActionsStatus), the
 * index-DESC/id-DESC run orders, the JobOrderByMap sort/order 422s, the
 * actor 404 text, the org-scope accessible-repos subquery, the embedded
 * repository's ZERO permission block, and the pull_requests arms
 * (push-open-PR / PR-ref / exclude).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunAttempts,
  actionRunJobs,
  actionRunners,
  actionRuns,
  actionTaskSteps,
  actionTasks,
  actionTasksVersions,
  issues,
  pullRequests,
  repositories,
  users,
} from "../../db/schema";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  insertActionRun,
  type RunnerRow,
  type RunJobRow,
  type RunRow,
} from "../../services/actions/model";
import type { PullRequestRow } from "../../issues/service";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerSecretsVariablesRoutes } from "./secrets-variables";
import { OrgService } from "../../services/orgs/orgs";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "secrets",
    "action_variables",
    "action_runners",
    "action_runner_tokens",
    "action_tasks_versions",
    "action_task_steps",
    "action_tasks",
    "action_run_attempts",
    "action_run_jobs",
    "action_runs",
    "pull_requests",
    "issues",
    "repo_collaborators",
    "repositories",
    "org_members",
    "user_redirects",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (hooks-scopes.test.ts's pattern):
// tokens bind to seeded D1 users, so the ownership gates read what the seeds
// wrote. Ids are NEVER hardcoded — every test reads the seeded ids back.
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

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
  return { id: user.id, username: user.username, isAdmin };
}

/** API `User` projection the resolver returns (the auth middleware's shape). */
function apiUser(user: SeededUser): User {
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

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** Local mount of exactly the orchestrator one-liner's seam. The registry
 *  paths are relative to the /api/v1 mount, so fetched paths strip the
 *  prefix (the deploy-keys.test.ts convention). */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerSecretsVariablesRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const put = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, {
    method: "PUT",
    headers: userId === undefined ? { "Content-Type": "application/json" } : authHeaders(userId),
    body: JSON.stringify(body),
  });

const post = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, {
    method: "POST",
    headers: userId === undefined ? { "Content-Type": "application/json" } : authHeaders(userId),
    body: JSON.stringify(body),
  });

const del = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: userId === undefined ? {} : authHeaders(userId) });

const patch = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, {
    method: "PATCH",
    headers: userId === undefined ? { "Content-Type": "application/json" } : authHeaders(userId),
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** The canonical user world: alice (the repo owner by login match), bob (a
 *  plain second user), the site admin. */
async function seedWorld(): Promise<{ alice: SeededUser; bob: SeededUser; admin: SeededUser }> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const admin = await seedUser("site-admin", true);
  return { alice, bob, admin };
}

let repoSeq = 8600;

/** One user-owned repo (public, not archived). */
async function seedRepo(owner: SeededUser): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `repo${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: owner.username,
    ownerId: owner.id,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return { slug, repoId };
}

interface OrgSeed {
  orgId: number;
  owner: SeededUser;
  member: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
}

/** The standard org: an owner, a plain member, an outsider and a site admin.
 *  The org admin's name is org-scoped so a test seeding BOTH helpers (the
 *  isolation suite) never collides on users.username_lower. */
async function seedOrg(name = "acme", visibility: "public" | "limited" | "private" = "public"): Promise<OrgSeed> {
  const owner = await seedUser(`${name}-owner`);
  const member = await seedUser(`${name}-member`);
  const outsider = await seedUser(`${name}-outsider`);
  const admin = await seedUser(`${name}-site-admin`, true);
  const org = await new OrgService(env.DB).createOrg({
    name,
    ownerId: owner.id,
    visibility,
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await new OrgService(env.DB).addMember(org.id, member.id);
  return { orgId: org.id, owner, member, outsider, admin };
}

interface SecretWire {
  name: string;
  description: string;
  created_at: string;
}

interface VariableWire {
  owner_id: number;
  repo_id: number;
  name: string;
  data: string;
  description: string;
}

interface RunnerLabelWire {
  id: number;
  name: string;
  type: string;
}

interface RunnerWire {
  id: number;
  name: string;
  status: "online" | "offline";
  busy: boolean;
  disabled: boolean;
  ephemeral: boolean;
  labels: RunnerLabelWire[];
}

interface RunnerListWire {
  runners: RunnerWire[];
  total_count: number;
}

let runnerSeq = 9000;

interface RunnerSeedTimes {
  lastOnline?: Date | null;
  lastActive?: Date | null;
  isDisabled?: boolean;
  agentLabels?: string[];
  ephemeral?: boolean;
}

/** One runner row straight into the control-plane store (bypassing the
 *  Register protocol — the API family manages ALREADY-registered rows), with
 *  caller-controlled heartbeats so the status matrix is deterministic. */
async function seedRunner(
  scope: { ownerId: number; repoId: string },
  name: string,
  times: RunnerSeedTimes = {},
): Promise<RunnerRow> {
  const now = new Date();
  const rows = await db()
    .insert(actionRunners)
    .values({
      uuid: crypto.randomUUID(),
      name,
      version: "1.0.0",
      ownerId: scope.ownerId,
      repoId: scope.repoId,
      agentLabels: JSON.stringify(times.agentLabels ?? []),
      ephemeral: times.ephemeral ?? false,
      isDisabled: times.isDisabled ?? false,
      tokenHash: `hash-${name}-${runnerSeq++}`,
      tokenSalt: "salt",
      lastOnline: times.lastOnline !== undefined ? times.lastOnline : now,
      lastActive: times.lastActive !== undefined ? times.lastActive : now,
      created: now,
      updated: now,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("runner seed failed");
  return row;
}

const messageOf = async (res: Response): Promise<string> => (await jsonBody<{ message: string }>(res)).message;

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

// ---------------------------------------------------------------------------
// REPO SCOPE — secrets (repoListActionsSecrets / updateRepoSecret /
// deleteRepoSecret)
// ---------------------------------------------------------------------------

describe("repo secrets (GET/PUT/DELETE /repos/{owner}/{repo}/actions/secrets)", () => {
  it("PUT 201 creates, 204 updates; the list renders name/description/created_at and never the data", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const created = await put(`/api/v1/repos/alice/${slug}/actions/secrets/DEPLOY_KEY`, { data: "s3cr3t", description: "ci key" }, alice.id);
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("");

    // The lookup uppercases — the same secret under any case is an UPDATE.
    // An absent description carries Go's zero value: the update CLEARS it
    // (UpdateSecret overwrites description unconditionally, secret.go:137-152).
    const updated = await put(`/api/v1/repos/alice/${slug}/actions/secrets/deploy_key`, { data: "s3cr3t-v2" }, alice.id);
    expect(updated.status).toBe(204);

    const list = await get(`/api/v1/repos/alice/${slug}/actions/secrets`, alice.id);
    expect(list.status).toBe(200);
    const body = (await jsonBody<SecretWire[]>(list));
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("DEPLOY_KEY");
    expect(body[0]!.description).toBe("");
    expect(body[0]!.created_at).toBe(new Date(body[0]!.created_at).toISOString());
    expect(JSON.stringify(body)).not.toContain("s3cr3t");
  });

  it("the list is name-ordered and paginated (X-Total-Count + Link)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    for (const name of ["BETA", "ALPHA", "GAMMA"]) {
      expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/${name}`, { data: "v" }, alice.id)).status).toBe(201);
    }
    const res = await get(`/api/v1/repos/alice/${slug}/actions/secrets?page=1&limit=2`, alice.id);
    expect(res.status).toBe(200);
    const body = (await jsonBody<SecretWire[]>(res));
    expect(body.map((s) => s.name)).toEqual(["ALPHA", "BETA"]);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    expect(res.headers.get("Link")).toContain('rel="next"');
  });

  it("DELETE 204 removes; a miss takes the empty-name ErrSecretNotFound text", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await put(`/api/v1/repos/alice/${slug}/actions/secrets/TOKEN`, { data: "v" }, alice.id);
    const gone = await del(`/api/v1/repos/alice/${slug}/actions/secrets/token`, alice.id);
    expect(gone.status).toBe(204);
    const miss = await del(`/api/v1/repos/alice/${slug}/actions/secrets/TOKEN`, alice.id);
    expect(miss.status).toBe(404);
    const body = await jsonBody<{ message: string; url: string }>(miss);
    expect(body.message).toBe("secret was not found [name: ]");
    expect(body.url).toBe(ERROR_URL);
  });

  it("400: the ValidateName arms — pattern, forbidden prefix, reserved CI", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const badPattern = await put(`/api/v1/repos/alice/${slug}/actions/secrets/has-hyphen`, { data: "v" }, alice.id);
    expect(badPattern.status).toBe(400);
    expect(await messageOf(badPattern)).toBe(
      "name must start with a letter or underscore and contain only letters, numbers, and underscores",
    );
    const giteaPrefix = await put(`/api/v1/repos/alice/${slug}/actions/secrets/gitea_token`, { data: "v" }, alice.id);
    expect(giteaPrefix.status).toBe(400);
    expect(await messageOf(giteaPrefix)).toBe("name cannot start with 'GITEA_' or 'GITHUB_'");
    const githubPrefix = await put(`/api/v1/repos/alice/${slug}/actions/secrets/GITHUB_TOKEN`, { data: "v" }, alice.id);
    expect(githubPrefix.status).toBe(400);
    const reserved = await put(`/api/v1/repos/alice/${slug}/actions/secrets/ci`, { data: "v" }, alice.id);
    expect(reserved.status).toBe(400);
    expect(await messageOf(reserved)).toBe("'CI' is a reserved name");
  });

  it("400: secret data counts BYTES against SecretDataMaxLength (65536)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    // 65536 two-byte runes = 131072 bytes — over. 32768 of them = 65536 — fits.
    const ok = await put(`/api/v1/repos/alice/${slug}/actions/secrets/EDGE`, { data: "é".repeat(32768) }, alice.id);
    expect(ok.status).toBe(201);
    const tooLong = await put(`/api/v1/repos/alice/${slug}/actions/secrets/EDGE`, { data: "é".repeat(32769) }, alice.id);
    expect(tooLong.status).toBe(400);
    expect(await messageOf(tooLong)).toBe("data too long");
  });

  it("422 (runtime-only): the Go binder's Required text on a missing data", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const res = await put(`/api/v1/repos/alice/${slug}/actions/secrets/NOPE`, { description: "no data" }, alice.id);
    expect(res.status).toBe(422);
    expect(await messageOf(res)).toBe("Data: Required");
  });

  it("403 (runtime-only): reqOwner — an admin-mode COLLABORATOR ranks below AccessModeOwner", async () => {
    const { alice, bob, admin } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await env.DB.prepare("INSERT INTO repo_collaborators (repo_id, user_id, mode) VALUES (?, ?, 'admin')").bind(repoId, bob.id).run();
    const res = await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, { data: "v" }, bob.id);
    expect(res.status).toBe(403);
    expect(await messageOf(res)).toBe("user should be the owner of the repo");
    expect((await del(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, bob.id)).status).toBe(403);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/secrets`, bob.id)).status).toBe(403);
    // …while the owner passes and the site admin passes (the explicit arm).
    expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, { data: "v" }, alice.id)).status).toBe(201);
    expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY2`, { data: "v" }, admin.id)).status).toBe(201);
  });

  it("404: the anti-enumeration repo miss (unknown repo, unknown owner)", async () => {
    const { alice } = await seedWorld();
    await seedRepo(alice);
    expect((await get("/api/v1/repos/alice/missing/actions/secrets", alice.id)).status).toBe(404);
    expect((await put("/api/v1/repos/ghost/repo1/actions/secrets/KEY", { data: "v" }, alice.id)).status).toBe(404);
    expect((await del("/api/v1/repos/alice/missing/actions/secrets/KEY", alice.id)).status).toBe(404);
  });

  it("401 (runtime-only): reqToken rejects anonymous callers", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/secrets`)).status).toBe(401);
    expect((await put(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`, { data: "v" })).status).toBe(401);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/secrets/KEY`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// REPO SCOPE — variables (getRepoVariablesList / getRepoVariable /
// createRepoVariable / updateRepoVariable / deleteRepoVariable)
// ---------------------------------------------------------------------------

describe("repo variables (/repos/{owner}/{repo}/actions/variables)", () => {
  it("POST 201 creates; GET renders the full ActionVariable (owner_id 0, numeric repo_id, UPPER name, EOL-normalized data)", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const created = await post(`/api/v1/repos/alice/${slug}/actions/variables/build_num`, { value: "1\r\n2", description: "counter" }, alice.id);
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("");

    const got = await get(`/api/v1/repos/alice/${slug}/actions/variables/BUILD_NUM`, alice.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<VariableWire>(got))).toEqual({
      owner_id: 0,
      repo_id: Number(repoId),
      name: "BUILD_NUM",
      data: "1\n2",
      description: "counter",
    });
  });

  it("POST 409 on an existing name (checked case-insensitively)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/DUP`, { value: "v" }, alice.id);
    const res = await post(`/api/v1/repos/alice/${slug}/actions/variables/dup`, { value: "v2" }, alice.id);
    expect(res.status).toBe(409);
    expect(await messageOf(res)).toBe("variable name already exists");
  });

  it("POST 400: the ValidateName arms and the RUNE-counted data cap", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    expect((await post(`/api/v1/repos/alice/${slug}/actions/variables/9bad`, { value: "v" }, alice.id)).status).toBe(400);
    const tooLong = await post(`/api/v1/repos/alice/${slug}/actions/variables/BIG`, { value: "é".repeat(65537) }, alice.id);
    expect(tooLong.status).toBe(400);
    expect(await messageOf(tooLong)).toBe("data too long");
    // 65536 runes fits exactly — the cap is runes, unlike secrets' bytes.
    expect((await post(`/api/v1/repos/alice/${slug}/actions/variables/EDGE`, { value: "é".repeat(65536) }, alice.id)).status).toBe(201);
  });

  it("422 (runtime-only): the Go binder's Required text on a missing value", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const res = await post(`/api/v1/repos/alice/${slug}/actions/variables/NOPE`, { description: "no value" }, alice.id);
    expect(res.status).toBe(422);
    expect(await messageOf(res)).toBe("Value: Required");
  });

  it("GET 404 on a miss ('variable not found'); the list is name-ordered with X-Total-Count", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const miss = await get(`/api/v1/repos/alice/${slug}/actions/variables/ABSENT`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("variable not found");

    for (const name of ["ZED", "MID"]) {
      await post(`/api/v1/repos/alice/${slug}/actions/variables/${name}`, { value: "v" }, alice.id);
    }
    const res = await get(`/api/v1/repos/alice/${slug}/actions/variables`, alice.id);
    expect(res.status).toBe(200);
    expect(((await jsonBody<VariableWire[]>(res))).map((v) => v.name)).toEqual(["MID", "ZED"]);
    expect(res.headers.get("X-Total-Count")).toBe("2");
  });

  it("PUT 204 updates value and clears an absent description; the rename arm moves the row", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/OLD`, { value: "v1", description: "will vanish" }, alice.id);
    const renamed = await put(`/api/v1/repos/alice/${slug}/actions/variables/old`, { name: "NEW", value: "v2" }, alice.id);
    expect(renamed.status).toBe(204);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/variables/OLD`, alice.id)).status).toBe(404);
    const moved = (await jsonBody<VariableWire>(await get(`/api/v1/repos/alice/${slug}/actions/variables/new`, alice.id)));
    expect(moved.name).toBe("NEW");
    expect(moved.data).toBe("v2");
    expect(moved.description).toBe("");
  });

  it("PUT 404 on a miss; PUT 400 on a rename onto an invalid name", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/V`, { value: "v" }, alice.id);
    const miss = await put(`/api/v1/repos/alice/${slug}/actions/variables/ABSENT`, { value: "v" }, alice.id);
    expect(miss.status).toBe(404);
    const badRename = await put(`/api/v1/repos/alice/${slug}/actions/variables/V`, { name: "bad-name", value: "v" }, alice.id);
    expect(badRename.status).toBe(400);
    expect(await messageOf(badRename)).toBe(
      "name must start with a letter or underscore and contain only letters, numbers, and underscores",
    );
  });

  it("DELETE 204 removes; 404 on a miss", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/GONE`, { value: "v" }, alice.id);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/variables/gone`, alice.id)).status).toBe(204);
    const miss = await del(`/api/v1/repos/alice/${slug}/actions/variables/GONE`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("variable not found");
  });

  it("404 unknown repo across all five ops; 401 anonymous (the group gates)", async () => {
    const { alice } = await seedWorld();
    await seedRepo(alice);
    expect((await get("/api/v1/repos/alice/missing/actions/variables", alice.id)).status).toBe(404);
    expect((await post("/api/v1/repos/alice/missing/actions/variables/V", { value: "v" }, alice.id)).status).toBe(404);
    expect((await get("/api/v1/repos/alice/missing/actions/variables/V", alice.id)).status).toBe(404);
    expect((await put("/api/v1/repos/alice/missing/actions/variables/V", { value: "v" }, alice.id)).status).toBe(404);
    expect((await del("/api/v1/repos/alice/missing/actions/variables/V", alice.id)).status).toBe(404);
    const { slug } = await seedRepo(alice);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/variables`)).status).toBe(401);
    expect((await post(`/api/v1/repos/alice/${slug}/actions/variables/V`, { value: "v" })).status).toBe(401);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/variables/V`)).status).toBe(401);
    expect((await put(`/api/v1/repos/alice/${slug}/actions/variables/V`, { value: "v" })).status).toBe(401);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/variables/V`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ORG SCOPE (8 ops) — the reqOrgOwnership gate + owner-scope storage
// ---------------------------------------------------------------------------

describe("org secrets and variables (/orgs/{org}/actions/...)", () => {
  it("secrets: PUT 201/204, list 200, DELETE 204/404 — all behind org ownership", async () => {
    const org = await seedOrg();
    const base = "/api/v1/orgs/acme/actions/secrets";
    expect((await put(`${base}/ORG_TOKEN`, { data: "v", description: "d" }, org.owner.id)).status).toBe(201);
    expect((await put(`${base}/ORG_TOKEN`, { data: "v2" }, org.owner.id)).status).toBe(204);

    const list = await get(base, org.owner.id);
    expect(list.status).toBe(200);
    const body = (await jsonBody<SecretWire[]>(list));
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("ORG_TOKEN");
    expect(JSON.stringify(body)).not.toContain("v2");

    expect((await del(`${base}/org_token`, org.owner.id)).status).toBe(204);
    const miss = await del(`${base}/ORG_TOKEN`, org.owner.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("secret was not found [name: ]");
  });

  it("variables: full CRUD with the owner_id=org, repo_id=0 wire shape", async () => {
    const org = await seedOrg();
    const base = "/api/v1/orgs/acme/actions/variables";
    expect((await post(`${base}/org_var`, { value: "ov", description: "d" }, org.owner.id)).status).toBe(201);
    const dup = await post(`${base}/ORG_VAR`, { value: "again" }, org.owner.id);
    expect(dup.status).toBe(409);
    expect(await messageOf(dup)).toBe("variable name already exists");

    const got = await get(`${base}/org_var`, org.owner.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<VariableWire>(got))).toEqual({
      owner_id: org.orgId,
      repo_id: 0,
      name: "ORG_VAR",
      data: "ov",
      description: "d",
    });

    const list = await get(base, org.owner.id);
    expect(((await jsonBody<VariableWire[]>(list))).map((v) => v.name)).toEqual(["ORG_VAR"]);
    expect(list.headers.get("X-Total-Count")).toBe("1");

    expect((await put(`${base}/ORG_VAR`, { value: "ov2" }, org.owner.id)).status).toBe(204);
    expect(((await jsonBody<VariableWire>(await get(`${base}/ORG_VAR`, org.owner.id)))).data).toBe("ov2");

    expect((await del(`${base}/ORG_VAR`, org.owner.id)).status).toBe(204);
    const miss = await del(`${base}/ORG_VAR`, org.owner.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("variable not found");
  });

  it("403: reqOrgOwnership — a plain member (even on a public org) takes upstream's exact message", async () => {
    const org = await seedOrg();
    expect((await put("/api/v1/orgs/acme/actions/secrets/KEY", { data: "v" }, org.member.id)).status).toBe(403);
    const res = await post("/api/v1/orgs/acme/actions/variables/V", { value: "v" }, org.member.id);
    expect(res.status).toBe(403);
    expect(await messageOf(res)).toBe("Must be an organization owner");
    // …the site admin passes (the explicit reqOrgOwnership arm).
    expect((await put("/api/v1/orgs/acme/actions/secrets/KEY", { data: "v" }, org.admin.id)).status).toBe(201);
  });

  it("404: unknown org across all eight ops; the 400 validation arms still fire for owners", async () => {
    const org = await seedOrg();
    expect((await get("/api/v1/orgs/missing/actions/secrets", org.owner.id)).status).toBe(404);
    expect((await put("/api/v1/orgs/missing/actions/secrets/KEY", { data: "v" }, org.owner.id)).status).toBe(404);
    expect((await del("/api/v1/orgs/missing/actions/secrets/KEY", org.owner.id)).status).toBe(404);
    expect((await get("/api/v1/orgs/missing/actions/variables", org.owner.id)).status).toBe(404);
    expect((await get("/api/v1/orgs/missing/actions/variables/V", org.owner.id)).status).toBe(404);
    expect((await post("/api/v1/orgs/missing/actions/variables/V", { value: "v" }, org.owner.id)).status).toBe(404);
    expect((await put("/api/v1/orgs/missing/actions/variables/V", { value: "v" }, org.owner.id)).status).toBe(404);
    expect((await del("/api/v1/orgs/missing/actions/variables/V", org.owner.id)).status).toBe(404);
    const beta = await seedOrg("beta");
    expect((await put("/api/v1/orgs/beta/actions/secrets/bad-name", { data: "v" }, beta.owner.id)).status).toBe(400);
    expect((await post("/api/v1/orgs/beta/actions/variables/CI", { value: "v" }, beta.owner.id)).status).toBe(400);
  });

  it("401 anonymous (the group's reqToken)", async () => {
    await seedOrg();
    expect((await get("/api/v1/orgs/acme/actions/secrets")).status).toBe(401);
    expect((await put("/api/v1/orgs/acme/actions/secrets/KEY", { data: "v" })).status).toBe(401);
    expect((await del("/api/v1/orgs/acme/actions/secrets/KEY")).status).toBe(401);
    expect((await get("/api/v1/orgs/acme/actions/variables")).status).toBe(401);
    expect((await get("/api/v1/orgs/acme/actions/variables/V")).status).toBe(401);
    expect((await post("/api/v1/orgs/acme/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await put("/api/v1/orgs/acme/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await del("/api/v1/orgs/acme/actions/variables/V")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// USER SCOPE (7 ops) — the /user group: the doer IS the owner
// ---------------------------------------------------------------------------

describe("user secrets and variables (/user/actions/...)", () => {
  it("secrets: PUT 201/204 and DELETE 204/404 scope to the doer", async () => {
    const { alice, bob } = await seedWorld();
    expect((await put("/api/v1/user/actions/secrets/MY_KEY", { data: "v", description: "mine" }, alice.id)).status).toBe(201);
    expect((await put("/api/v1/user/actions/secrets/my_key", { data: "v2" }, alice.id)).status).toBe(204);

    const noData = await put("/api/v1/user/actions/secrets/NO_DATA", { description: "x" }, alice.id);
    expect(noData.status).toBe(422);
    expect(await messageOf(noData)).toBe("Data: Required");

    // bob's user scope is a DIFFERENT store — his reads/deletes miss.
    expect((await del("/api/v1/user/actions/secrets/MY_KEY", bob.id)).status).toBe(404);
    expect((await put("/api/v1/user/actions/secrets/MY_KEY", { data: "x" }, bob.id)).status).toBe(201);

    expect((await del("/api/v1/user/actions/secrets/MY_KEY", alice.id)).status).toBe(204);
    const miss = await del("/api/v1/user/actions/secrets/MY_KEY", alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("secret was not found [name: ]");
  });

  it("variables: full CRUD over the doer's scope (owner_id=doer, repo_id=0)", async () => {
    const { alice } = await seedWorld();
    expect((await post("/api/v1/user/actions/variables/my_var", { value: "uv", description: "d" }, alice.id)).status).toBe(201);
    expect((await post("/api/v1/user/actions/variables/MY_VAR", { value: "dup" }, alice.id)).status).toBe(409);

    const got = await get("/api/v1/user/actions/variables/my_var", alice.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<VariableWire>(got))).toEqual({
      owner_id: alice.id,
      repo_id: 0,
      name: "MY_VAR",
      data: "uv",
      description: "d",
    });

    const list = await get("/api/v1/user/actions/variables", alice.id);
    expect(list.status).toBe(200);
    expect(((await jsonBody<VariableWire[]>(list))).map((v) => v.name)).toEqual(["MY_VAR"]);

    expect((await put("/api/v1/user/actions/variables/MY_VAR", { name: "RENAMED", value: "uv2" }, alice.id)).status).toBe(204);
    expect(((await jsonBody<VariableWire>(await get("/api/v1/user/actions/variables/RENAMED", alice.id)))).name).toBe("RENAMED");
    expect((await put("/api/v1/user/actions/variables/ABSENT", { value: "v" }, alice.id)).status).toBe(404);

    expect((await del("/api/v1/user/actions/variables/RENAMED", alice.id)).status).toBe(204);
    expect((await del("/api/v1/user/actions/variables/RENAMED", alice.id)).status).toBe(404);
  });

  it("user-scope name validation still 400s; the user scope has no secrets-list op", async () => {
    const { alice } = await seedWorld();
    expect((await post("/api/v1/user/actions/variables/github_x", { value: "v" }, alice.id)).status).toBe(400);
    expect((await put("/api/v1/user/actions/secrets/9bad", { data: "v" }, alice.id)).status).toBe(400);
    // Upstream declares no GET /user/actions/secrets — the path is un-routed
    // here too (the absence is part of the 23-op surface).
    expect((await get("/api/v1/user/actions/secrets", alice.id)).status).toBe(404);
  });

  it("401 anonymous (the /user group's reqToken)", async () => {
    await seedWorld();
    expect((await put("/api/v1/user/actions/secrets/KEY", { data: "v" })).status).toBe(401);
    expect((await del("/api/v1/user/actions/secrets/KEY")).status).toBe(401);
    expect((await get("/api/v1/user/actions/variables")).status).toBe(401);
    expect((await get("/api/v1/user/actions/variables/V")).status).toBe(401);
    expect((await post("/api/v1/user/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await put("/api/v1/user/actions/variables/V", { value: "v" })).status).toBe(401);
    expect((await del("/api/v1/user/actions/variables/V")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// SCOPE ISOLATION — the (owner_id, repo_id, name) triple keeps the three
// stores disjoint
// ---------------------------------------------------------------------------

describe("scope isolation", () => {
  it("the same name lives independently in all three scopes; deleting one leaves the siblings", async () => {
    const { alice } = await seedWorld();
    const org = await seedOrg("acme");
    const { slug, repoId } = await seedRepo(alice);

    await put(`/api/v1/repos/alice/${slug}/actions/secrets/SHARED`, { data: "repo-v" }, alice.id);
    await put("/api/v1/orgs/acme/actions/secrets/SHARED", { data: "org-v" }, org.owner.id);
    await put("/api/v1/user/actions/secrets/SHARED", { data: "user-v" }, alice.id);
    await post(`/api/v1/repos/alice/${slug}/actions/variables/SHARED`, { value: "repo-v" }, alice.id);
    await post("/api/v1/orgs/acme/actions/variables/SHARED", { value: "org-v" }, org.owner.id);
    await post("/api/v1/user/actions/variables/SHARED", { value: "user-v" }, alice.id);

    const repoSecrets = (await jsonBody<SecretWire[]>(await get(`/api/v1/repos/alice/${slug}/actions/secrets`, alice.id)));
    expect(repoSecrets.map((s) => s.name)).toEqual(["SHARED"]);
    const orgSecrets = (await jsonBody<SecretWire[]>(await get("/api/v1/orgs/acme/actions/secrets", org.owner.id)));
    expect(orgSecrets).toHaveLength(1);
    const userVars = (await jsonBody<VariableWire[]>(await get("/api/v1/user/actions/variables", alice.id)));
    expect(userVars.map((v) => [v.name, v.data, v.owner_id])).toEqual([["SHARED", "user-v", alice.id]]);

    const repoVars = (await jsonBody<VariableWire[]>(await get(`/api/v1/repos/alice/${slug}/actions/variables`, alice.id)));
    expect(repoVars.map((v) => [v.name, v.data, v.owner_id, v.repo_id])).toEqual([["SHARED", "repo-v", 0, Number(repoId)]]);
    const orgVars = (await jsonBody<VariableWire[]>(await get("/api/v1/orgs/acme/actions/variables", org.owner.id)));
    expect(orgVars.map((v) => [v.name, v.data, v.owner_id, v.repo_id])).toEqual([["SHARED", "org-v", org.orgId, 0]]);

    // Deleting one scope's row leaves the siblings intact.
    await del(`/api/v1/repos/alice/${slug}/actions/secrets/SHARED`, alice.id);
    expect(((await jsonBody<SecretWire[]>(await get("/api/v1/orgs/acme/actions/secrets", org.owner.id))))).toHaveLength(1);
    expect((await get("/api/v1/user/actions/variables/SHARED", alice.id)).status).toBe(200);
    expect((await get("/api/v1/orgs/acme/actions/variables/SHARED", org.owner.id)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// RUNNERS — the P1-7 extension (15 ops): registration tokens, registry CRUD,
// the status matrix, the two 404 shapes, the scope guards
// ---------------------------------------------------------------------------

/** The status windows' test margins (runner.go:76-77): comfortably inside
 *  active (< 10 s idle), between idle and offline (30 s), and past offline
 *  (120 s). */
const T_ACTIVE = 0;
const T_IDLE = 30_000;
const T_OFFLINE = 120_000;

describe("repo runners (GET/POST/DELETE/PATCH /repos/{owner}/{repo}/actions/runners)", () => {
  it("POST registration-token 200s {token}, reuses the scope's active token, and pins the scope", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const first = await post(`/api/v1/repos/alice/${slug}/actions/runners/registration-token`, null, alice.id);
    expect(first.status).toBe(200);
    const body = await jsonBody<{ token: string }>(first);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    // GetOrCreateActiveRunnerToken REUSES the active token (a POST is not a
    // reset — runner_token.go:127-134).
    const second = await jsonBody<{ token: string }>(
      await post(`/api/v1/repos/alice/${slug}/actions/runners/registration-token`, null, alice.id),
    );
    expect(second.token).toBe(body.token);

    // The stored row carries the repo scope (owner_id 0 + the repo id).
    const stored = await env.DB.prepare("SELECT owner_id, repo_id, is_active FROM action_runner_tokens").first<{
      owner_id: number;
      repo_id: string;
      is_active: number;
    }>();
    expect(stored).toMatchObject({ owner_id: 0, repo_id: repoId, is_active: 1 });
  });

  it("GET list renders the ActionRunner wire exactly and orders by the status rank (active, idle, offline)", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const now = Date.now();
    const offline = await seedRunner(repoScopeSeed(repoId), "z-offline", {
      lastOnline: new Date(now - T_OFFLINE),
      lastActive: new Date(now - T_OFFLINE),
      agentLabels: ["ubuntu-latest"],
    });
    const idleRows = await seedRunner(repoScopeSeed(repoId), "m-idle", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_IDLE),
    });
    const active = await seedRunner(repoScopeSeed(repoId), "a-active", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_ACTIVE),
      agentLabels: ["fedora-latest", "docker"],
    });

    const list = await get(`/api/v1/repos/alice/${slug}/actions/runners`, alice.id);
    expect(list.status).toBe(200);
    expect(list.headers.get("x-total-count")).toBe("3");
    const wire = await jsonBody<RunnerListWire>(list);
    expect(wire.total_count).toBe(3);
    expect(wire.runners.map((r) => r.name)).toEqual(["a-active", "m-idle", "z-offline"]);
    expect(wire.runners.map((r) => [r.status, r.busy])).toEqual([
      ["online", true],
      ["online", false],
      ["offline", false],
    ]);
    // The full ActionRunner wire for one entry — labels index as ids, type
    // "custom" (convert.go:800-808).
    expect(wire.runners[0]).toEqual({
      id: active.id,
      name: "a-active",
      status: "online",
      busy: true,
      disabled: false,
      ephemeral: false,
      labels: [
        { id: 0, name: "fedora-latest", type: "custom" },
        { id: 1, name: "docker", type: "custom" },
      ],
    });
    expect(wire.runners[2]?.id).toBe(offline.id);
    expect(wire.runners[1]?.id).toBe(idleRows.id);
  });

  it("the disabled query filter — true/false, and an unparsable value parses FALSE (FormOptionalBool)", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await seedRunner(repoScopeSeed(repoId), "enabled-1");
    await seedRunner(repoScopeSeed(repoId), "enabled-2");
    await seedRunner(repoScopeSeed(repoId), "paused", { isDisabled: true });

    const names = async (q: string): Promise<string[]> =>
      (await jsonBody<RunnerListWire>(await get(`/api/v1/repos/alice/${slug}/actions/runners${q}`, alice.id))).runners.map((r) => r.name);
    expect(await names("")).toEqual(["enabled-1", "enabled-2", "paused"]);
    expect(await names("?disabled=false")).toEqual(["enabled-1", "enabled-2"]);
    expect(await names("?disabled=true")).toEqual(["paused"]);
    // strconv.ParseBool's ignored-error arm (base_form.go:76): "yes" parses
    // as false, so the filter selects the NON-disabled rows.
    expect(await names("?disabled=yes")).toEqual(["enabled-1", "enabled-2"]);
  });

  it("list pagination rides page/limit with the total-count header", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await seedRunner(repoScopeSeed(repoId), "r1");
    await seedRunner(repoScopeSeed(repoId), "r2");
    await seedRunner(repoScopeSeed(repoId), "r3");
    const page2 = await get(`/api/v1/repos/alice/${slug}/actions/runners?limit=1&page=2`, alice.id);
    expect(page2.status).toBe(200);
    expect(page2.headers.get("x-total-count")).toBe("3");
    const wire = await jsonBody<RunnerListWire>(page2);
    expect(wire.runners).toHaveLength(1);
    expect(wire.runners[0]?.name).toBe("r2");
  });

  it("GET by id 200; the two 404 shapes — the not-exist text vs the foreign-scope text; non-numeric id is the id-0 miss", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const org = await seedOrg("acme");
    const runner = await seedRunner(repoScopeSeed(repoId), "repo-runner");
    const orgRunner = await seedRunner(ownerScopeSeed(org.orgId), "org-runner");

    const got = await get(`/api/v1/repos/alice/${slug}/actions/runners/${runner.id}`, alice.id);
    expect(got.status).toBe(200);
    expect((await jsonBody<RunnerWire>(got)).name).toBe("repo-runner");

    const miss = await get(`/api/v1/repos/alice/${slug}/actions/runners/999999`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("runner with id 999999: resource does not exist");

    // An org-scoped runner is NOT editable in the repo context
    // (EditableInContext, runner.go:158-169) — the "No permission" text.
    const foreign = await get(`/api/v1/repos/alice/${slug}/actions/runners/${orgRunner.id}`, alice.id);
    expect(foreign.status).toBe(404);
    expect(await messageOf(foreign)).toBe("No permission to access this runner");

    // PathParamInt64's failure arm is 0 (base_path.go:35-38) → the id-0 miss.
    const nonNumeric = await get(`/api/v1/repos/alice/${slug}/actions/runners/abc`, alice.id);
    expect(nonNumeric.status).toBe(404);
    expect(await messageOf(nonNumeric)).toBe("runner with id 0: resource does not exist");
  });

  it("PATCH 200 flips disabled and re-renders; the idempotent PATCH no-ops (no task-version bump); 422 on a missing disabled", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const runner = await seedRunner(repoScopeSeed(repoId), "flip-me");

    const flip = await patch(`/api/v1/repos/alice/${slug}/actions/runners/${runner.id}`, { disabled: true }, alice.id);
    expect(flip.status).toBe(200);
    expect((await jsonBody<RunnerWire>(flip))).toMatchObject({ id: runner.id, disabled: true });
    // SetRunnerDisabled's real flip bumps the scope's task version
    // (runner.go:364) — the cascade plants the missing scope rows.
    const bumped = await db().select({ n: count() }).from(actionTasksVersions).where(eq(actionTasksVersions.repoId, repoId));
    expect(bumped[0]?.n).toBeGreaterThan(0);

    // The equal-value PATCH returns early (runner.go:355-357) — the version
    // table does NOT grow (the earlier flip's rows are all there are).
    const beforeRows = await db().select({ n: count() }).from(actionTasksVersions);
    const fresh = await seedRunner(repoScopeSeed(repoId), "fresh-scope");
    const same = await patch(`/api/v1/repos/alice/${slug}/actions/runners/${fresh.id}`, { disabled: false }, alice.id);
    expect(same.status).toBe(200);
    const freshRows = await db().select({ n: count() }).from(actionTasksVersions);
    expect(freshRows[0]?.n).toBe(beforeRows[0]?.n);

    // Upstream order: the 404 arms fire BEFORE the Disabled-nil 422
    // (shared/runners.go:124-133) — a missing runner 404s even with {}.
    const missingWithEmptyBody = await patch(`/api/v1/repos/alice/${slug}/actions/runners/999999`, {}, alice.id);
    expect(missingWithEmptyBody.status).toBe(404);
    const noDisabled = await patch(`/api/v1/repos/alice/${slug}/actions/runners/${runner.id}`, {}, alice.id);
    expect(noDisabled.status).toBe(422);
    expect(await messageOf(noDisabled)).toBe("[Disabled]: Required");
  });

  it("DELETE 204 removes; the second delete is the not-exist 404; the foreign row 404s", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const org = await seedOrg("acme");
    const runner = await seedRunner(repoScopeSeed(repoId), "doomed");
    const orgRunner = await seedRunner(ownerScopeSeed(org.orgId), "org-runner");

    expect((await del(`/api/v1/repos/alice/${slug}/actions/runners/${orgRunner.id}`, alice.id)).status).toBe(404);
    expect((await del(`/api/v1/repos/alice/${slug}/actions/runners/${runner.id}`, alice.id)).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM action_runners").first<{ n: number }>())?.n).toBe(1);
    const miss = await del(`/api/v1/repos/alice/${slug}/actions/runners/${runner.id}`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe(`runner with id ${runner.id}: resource does not exist`);
  });

  it("403: a plain user (even the site admin's sibling non-owner) takes upstream's reqOwner message; the admin passes", async () => {
    const { alice, bob, admin } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const base = `/api/v1/repos/alice/${slug}/actions/runners`;
    for (const attempt of [get(`${base}`, bob.id), post(`${base}/registration-token`, null, bob.id), get(`${base}/1`, bob.id), del(`${base}/1`, bob.id), patch(`${base}/1`, { disabled: true }, bob.id)]) {
      const res = await attempt;
      expect(res.status).toBe(403);
      expect(await messageOf(res)).toBe("user should be the owner of the repo");
    }
    expect((await get(`${base}`, admin.id)).status).toBe(200);
  });

  it("401 anonymous on all five ops", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const base = `/api/v1/repos/alice/${slug}/actions/runners`;
    expect((await get(`${base}`)).status).toBe(401);
    expect((await post(`${base}/registration-token`, null)).status).toBe(401);
    expect((await get(`${base}/1`)).status).toBe(401);
    expect((await del(`${base}/1`)).status).toBe(401);
    expect((await patch(`${base}/1`, { disabled: true })).status).toBe(401);
  });
});

describe("org runners (/orgs/{org}/actions/runners)", () => {
  it("the five ops over the org scope; the owner-scope encoding pins (owner_id=org, repo_id='')", async () => {
    const org = await seedOrg("acme");
    const now = Date.now();
    const runner = await seedRunner(ownerScopeSeed(org.orgId), "org-runner", {
      lastOnline: new Date(now),
      lastActive: new Date(now),
      agentLabels: ["self-hosted"],
    });

    const token = await jsonBody<{ token: string }>(await post("/api/v1/orgs/acme/actions/runners/registration-token", null, org.owner.id));
    expect(typeof token.token).toBe("string");
    const stored = await env.DB.prepare("SELECT owner_id, repo_id FROM action_runner_tokens").first<{ owner_id: number; repo_id: string }>();
    expect(stored).toMatchObject({ owner_id: org.orgId, repo_id: "" });

    const list = await get("/api/v1/orgs/acme/actions/runners", org.owner.id);
    expect(list.status).toBe(200);
    const wire = await jsonBody<RunnerListWire>(list);
    expect(wire.total_count).toBe(1);
    expect(wire.runners[0]).toMatchObject({ id: runner.id, name: "org-runner", status: "online", busy: true });

    const got = await get(`/api/v1/orgs/acme/actions/runners/${runner.id}`, org.owner.id);
    expect(got.status).toBe(200);

    const flipped = await patch(`/api/v1/orgs/acme/actions/runners/${runner.id}`, { disabled: true }, org.owner.id);
    expect(flipped.status).toBe(200);
    expect((await jsonBody<RunnerWire>(flipped)).disabled).toBe(true);
    // The disabled filter now hides it.
    const hidden = await jsonBody<RunnerListWire>(await get("/api/v1/orgs/acme/actions/runners?disabled=false", org.owner.id));
    expect(hidden.total_count).toBe(0);

    expect((await del(`/api/v1/orgs/acme/actions/runners/${runner.id}`, org.owner.id)).status).toBe(204);
    const miss = await del(`/api/v1/orgs/acme/actions/runners/${runner.id}`, org.owner.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe(`runner with id ${runner.id}: resource does not exist`);
  });

  it("403: a plain member and an outsider take reqOrgOwnership's message; a foreign repo-scoped runner 404s with the permission text", async () => {
    const org = await seedOrg("acme");
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const repoRunner = await seedRunner(repoScopeSeed(repoId), "repo-runner");

    const memberAttempt = await get("/api/v1/orgs/acme/actions/runners", org.member.id);
    expect(memberAttempt.status).toBe(403);
    expect(await messageOf(memberAttempt)).toBe("Must be an organization owner");
    expect((await post("/api/v1/orgs/acme/actions/runners/registration-token", null, org.outsider.id)).status).toBe(403);

    const foreign = await get(`/api/v1/orgs/acme/actions/runners/${repoRunner.id}`, org.owner.id);
    expect(foreign.status).toBe(404);
    expect(await messageOf(foreign)).toBe("No permission to access this runner");
    expect(slug.length).toBeGreaterThan(0);
  });

  it("401 anonymous on all five ops", async () => {
    await seedOrg("acme");
    expect((await get("/api/v1/orgs/acme/actions/runners")).status).toBe(401);
    expect((await post("/api/v1/orgs/acme/actions/runners/registration-token", null)).status).toBe(401);
    expect((await get("/api/v1/orgs/acme/actions/runners/1")).status).toBe(401);
    expect((await del("/api/v1/orgs/acme/actions/runners/1")).status).toBe(401);
    expect((await patch("/api/v1/orgs/acme/actions/runners/1", { disabled: true })).status).toBe(401);
  });
});

describe("user runners (/user/actions/runners)", () => {
  it("the five ops over the doer's own scope; siblings' rows are foreign", async () => {
    const { alice, bob } = await seedWorld();
    const now = Date.now();
    const runner = await seedRunner(ownerScopeSeed(alice.id), "alice-runner", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_IDLE),
    });

    const token = await jsonBody<{ token: string }>(await post("/api/v1/user/actions/runners/registration-token", null, alice.id));
    expect(typeof token.token).toBe("string");
    // bob's token mint is a DIFFERENT scope row.
    const bobToken = await jsonBody<{ token: string }>(await post("/api/v1/user/actions/runners/registration-token", null, bob.id));
    expect(bobToken.token).not.toBe(token.token);

    const list = await get("/api/v1/user/actions/runners", alice.id);
    expect(list.status).toBe(200);
    const wire = await jsonBody<RunnerListWire>(list);
    expect(wire.total_count).toBe(1);
    expect(wire.runners[0]).toMatchObject({ id: runner.id, status: "online", busy: false });

    // bob sees an EMPTY list (his scope) and alice's runner is foreign.
    expect((await jsonBody<RunnerListWire>(await get("/api/v1/user/actions/runners", bob.id))).total_count).toBe(0);
    const foreign = await get(`/api/v1/user/actions/runners/${runner.id}`, bob.id);
    expect(foreign.status).toBe(404);
    expect(await messageOf(foreign)).toBe("No permission to access this runner");

    const flipped = await patch(`/api/v1/user/actions/runners/${runner.id}`, { disabled: true }, alice.id);
    expect(flipped.status).toBe(200);
    expect((await jsonBody<RunnerWire>(flipped)).disabled).toBe(true);

    expect((await del(`/api/v1/user/actions/runners/${runner.id}`, alice.id)).status).toBe(204);
    const miss = await del(`/api/v1/user/actions/runners/${runner.id}`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe(`runner with id ${runner.id}: resource does not exist`);
  });

  it("401 anonymous on all five ops", async () => {
    await seedWorld();
    expect((await get("/api/v1/user/actions/runners")).status).toBe(401);
    expect((await post("/api/v1/user/actions/runners/registration-token", null)).status).toBe(401);
    expect((await get("/api/v1/user/actions/runners/1")).status).toBe(401);
    expect((await del("/api/v1/user/actions/runners/1")).status).toBe(401);
    expect((await patch("/api/v1/user/actions/runners/1", { disabled: true })).status).toBe(401);
  });
});

/** Seed-scope builders mirroring the service's sentinel encoding (repo rows
 *  carry owner_id 0; owner rows carry repo_id ''). */
function repoScopeSeed(repoId: string): { ownerId: number; repoId: string } {
  return { ownerId: 0, repoId };
}

function ownerScopeSeed(ownerId: number): { ownerId: number; repoId: string } {
  return { ownerId, repoId: "" };
}

// ---------------------------------------------------------------------------
// RUNS/JOBS LISTING — the P1-8 family (6 ops). The rows ride the LANDED
// insertion seam (insertActionRun — the M1a staged insert the rerun/dispatch
// suites drive); statuses are settled with direct updates, exactly the
// rerun-suite pattern. Pins: the wire envelopes, the status-word matrix,
// the orders (index DESC repo-scoped / id DESC owner-scoped), the filters,
// the sort/order 422s, the actor 404 text, the pull_requests arms, the
// embedded repository's ZERO permission block, the per-scope gates (repo
// READER vs org MEMBERSHIP), and the org-scope accessible-repos filter.
// ---------------------------------------------------------------------------

const GO_ZERO = "0001-01-01T00:00:00Z";

interface PullRequestMinimalWire {
  id: number;
  number: number;
  url: string;
  head: { ref: string; sha: string; repo: { id: number; url: string; name: string } };
  base: { ref: string; sha: string; repo: { id: number; url: string; name: string } };
}

interface WorkflowRunWire {
  id: number;
  url: string;
  previous_attempt_url: string | null;
  html_url: string;
  jobs_url: string;
  logs_url: string;
  artifacts_url: string;
  cancel_url: string;
  rerun_url: string;
  display_title: string;
  path: string;
  event: string;
  run_attempt: number;
  run_number: number;
  head_sha: string;
  head_branch?: string;
  status: string;
  conclusion?: string;
  actor?: User;
  trigger_actor?: User;
  repository?: Record<string, unknown>;
  pull_requests: PullRequestMinimalWire[];
  created_at: string;
  updated_at: string;
  started_at: string;
  completed_at: string;
}

interface WorkflowRunsEnvelope {
  workflow_runs: WorkflowRunWire[];
  total_count: number;
}

interface WorkflowStepWire {
  name: string;
  number: number;
  status: string;
  conclusion?: string;
  started_at: string;
  completed_at: string;
}

interface WorkflowJobWire {
  id: number;
  url: string;
  html_url: string;
  run_id: number;
  run_url: string;
  name: string;
  labels: string[];
  run_attempt: number;
  head_sha: string;
  head_branch?: string;
  status: string;
  conclusion?: string;
  runner_id?: number;
  runner_name?: string;
  steps: WorkflowStepWire[];
  created_at: string;
  started_at: string;
  completed_at: string;
}

interface WorkflowJobsEnvelope {
  jobs: WorkflowJobWire[];
  total_count: number;
}

/** Distinct 40-char shas (the hex rendering keeps them column-typical). */
const sha40 = (n: number): string => n.toString(16).padStart(40, "0");

const WORKFLOW_PAYLOAD = new TextEncoder().encode(
  "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
);

let actionRunSeq = 1;
let actionTaskSeq = 5000;

interface ActionRunSeed {
  index?: number;
  ref?: string;
  commitSha?: string;
  event?: string;
  triggerEvent?: string;
  title?: string;
  needApproval?: boolean;
  runStatus?: number;
  triggerUserId?: number;
  jobs?: Array<{
    jobId: string;
    name?: string;
    runsOn?: string[];
    status?: number;
    started?: Date | null;
    stopped?: Date | null;
  }>;
}

/** One run through the LANDED insertion seam (the rerun suite's pattern),
 *  then the caller's status overrides settled with direct updates. */
async function seedActionRun(
  repoId: string,
  ownerId: number,
  seed: ActionRunSeed = {},
): Promise<{ run: RunRow; attemptId: number; jobIds: number[]; jobRows: RunJobRow[] }> {
  const seq = actionRunSeq++;
  const { run, attempt, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId,
      ownerId,
      workflowId: ".gitea/workflows/ci.yml",
      index: seed.index ?? seq,
      triggerUserId: seed.triggerUserId ?? ownerId,
      ref: seed.ref ?? "refs/heads/main",
      commitSha: seed.commitSha ?? sha40(0xa000 + seq),
      event: seed.event ?? "push",
      eventPayload: "{}",
      triggerEvent: seed.triggerEvent ?? "push",
      title: seed.title,
    },
    (seed.jobs ?? [{ jobId: "build", runsOn: ["ubuntu-latest"] }]).map((job) => ({
      jobId: job.jobId,
      name: job.name,
      runsOn: job.runsOn,
      workflowPayload: WORKFLOW_PAYLOAD,
    })),
  );
  if (seed.runStatus !== undefined || seed.needApproval !== undefined) {
    await db()
      .update(actionRuns)
      .set({
        ...(seed.runStatus !== undefined ? { status: seed.runStatus } : {}),
        ...(seed.needApproval !== undefined ? { needApproval: seed.needApproval } : {}),
      })
      .where(eq(actionRuns.id, run.id));
    await db()
      .update(actionRunAttempts)
      .set({ status: seed.runStatus ?? attempt.status })
      .where(eq(actionRunAttempts.id, attempt.id));
  }
  const jobsWithStatus = (seed.jobs ?? []).filter((job) => job.status !== undefined);
  for (const job of jobsWithStatus) {
    const row = jobRows.find((r) => r.jobId === job.jobId)!;
    await db()
      .update(actionRunJobs)
      .set({ status: job.status!, started: job.started ?? null, stopped: job.stopped ?? null })
      .where(eq(actionRunJobs.id, row.id));
  }
  return { run, attemptId: attempt.id, jobIds: jobRows.map((j) => j.id), jobRows };
}

/** A user-owned repo in the org's name (orgs ARE users rows — the
 *  createOrgRepo precedent) so the repos ⋈ users join resolves it. */
async function seedOrgRepo(orgName: string, orgId: number, visibility: "public" | "private" = "public"): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `orgrepo${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: orgName,
    ownerId: orgId,
    slug,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return { slug, repoId };
}

/** A PR row pair (issue + extension) written straight into the stores. */
async function seedPullRow(
  repoId: string,
  index: number,
  headBranch: string,
  opts: { closed?: boolean; merged?: boolean; mergeBase?: string } = {},
): Promise<PullRequestRow> {
  const issueRows = await db()
    .insert(issues)
    .values({
      repoId,
      index,
      title: `pr ${index}`,
      isPull: true,
      isClosed: opts.closed ?? false,
      createdAt: new Date("2026-03-01T00:00:00Z"),
      updatedAt: new Date("2026-03-01T00:00:00Z"),
    })
    .returning()
    .all();
  const prRows = await db()
    .insert(pullRequests)
    .values({
      issueId: issueRows[0]!.id,
      index,
      headRepoId: repoId,
      baseRepoId: repoId,
      headBranch,
      baseBranch: "main",
      hasMerged: opts.merged ?? false,
      mergeBase: opts.mergeBase ?? sha40(0xb000 + index),
    })
    .returning()
    .all();
  return prRows[0]!;
}

describe("repo workflow runs (GET /repos/{owner}/{repo}/actions/runs)", () => {
  it("200 with the empty envelope on a run-less repo (the M3-independent premise)", async () => {
    const { alice } = await seedWorld();
    const { slug } = await seedRepo(alice);
    const res = await get(`/api/v1/repos/alice/${slug}/actions/runs`, alice.id);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ workflow_runs: [], total_count: 0 });
    expect(res.headers.get("x-total-count")).toBe("0");
  });

  it("the ActionWorkflowRun wire pins exactly — URLs, the attempt mirror, the ZERO-permission repository embed", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const sha = sha40(0xc001);
    const seeded = await seedActionRun(repoId, alice.id, { commitSha: sha, title: "add ci" });
    const res = await get(`/api/v1/repos/alice/${slug}/actions/runs`, alice.id);
    expect(res.status).toBe(200);
    const body = (await jsonBody<WorkflowRunsEnvelope>(res));
    expect(body.total_count).toBe(1);
    const api = `https://example.com/api/v1/repos/alice/${slug}`;
    const html = `https://example.com/alice/${slug}`;
    const { repository, actor, trigger_actor: triggerActor, ...rest } = body.workflow_runs[0]!;
    expect(rest).toEqual({
      id: seeded.run.id,
      url: `${api}/actions/runs/${seeded.run.id}`,
      previous_attempt_url: null,
      html_url: `${html}/actions/runs/${seeded.run.id}`,
      jobs_url: `${api}/actions/runs/${seeded.run.id}/jobs`,
      logs_url: `${api}/actions/runs/${seeded.run.id}/logs`,
      artifacts_url: `${api}/actions/runs/${seeded.run.id}/artifacts`,
      cancel_url: `${api}/actions/runs/${seeded.run.id}/cancel`,
      rerun_url: `${api}/actions/runs/${seeded.run.id}/rerun`,
      display_title: "add ci",
      path: `.gitea/workflows/ci.yml@refs/heads/main`,
      event: "push",
      run_attempt: 1,
      run_number: seeded.run.index,
      head_sha: sha,
      head_branch: "main",
      status: "queued",
      pull_requests: [],
      created_at: seeded.run.created.toISOString(),
      updated_at: seeded.run.updated.toISOString(),
      started_at: GO_ZERO,
      completed_at: GO_ZERO,
    });
    expect(actor?.login).toBe("alice");
    expect(triggerActor?.login).toBe("alice");
    expect(repository).toMatchObject({
      id: Number(repoId),
      full_name: `alice/${slug}`,
      // ToRepo with AccessModeNone (convert.go:338) — the zero block,
      // doer-independent (repository.go:41-45).
      permissions: { admin: false, push: false, pull: false },
    });
  });

  it("the status-word matrix — ToRunActionsStatus over every internal rank", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    // [runStatus, needApproval, wire status, wire conclusion]
    const matrix: Array<[number, boolean | undefined, string, string | undefined]> = [
      [ACTION_STATUS_WAITING, undefined, "queued", undefined],
      [ACTION_STATUS_BLOCKED, undefined, "pending", undefined],
      [ACTION_STATUS_BLOCKED, true, "waiting", undefined],
      [ACTION_STATUS_RUNNING, undefined, "in_progress", undefined],
      [ACTION_STATUS_PENDING, undefined, "requested", undefined],
      [ACTION_STATUS_SUCCESS, undefined, "completed", "success"],
      [ACTION_STATUS_FAILURE, undefined, "completed", "failure"],
      [ACTION_STATUS_CANCELLED, undefined, "completed", "cancelled"],
      [ACTION_STATUS_SKIPPED, undefined, "completed", "skipped"],
    ];
    const numbers: number[] = [];
    for (const [status, needApproval] of matrix) {
      const seeded = await seedActionRun(repoId, alice.id, { runStatus: status, needApproval });
      numbers.push(seeded.run.index);
    }
    const body = (await jsonBody<WorkflowRunsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/runs`, alice.id),
    ));
    expect(body.total_count).toBe(matrix.length);
    for (let i = 0; i < matrix.length; i++) {
      const run = body.workflow_runs.find((r) => r.run_number === numbers[i])!;
      expect([run.status, run.conclusion]).toEqual([matrix[i]![2], matrix[i]![3]]);
    }
  });

  it("repo-scope order is index DESC (the per-repo run number); pagination rides page/limit", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    for (const n of [1, 2, 3]) {
      await seedActionRun(repoId, alice.id, { index: n, title: `run ${n}` });
    }
    const page1 = (await jsonBody<WorkflowRunsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/runs?page=1&limit=2`, alice.id),
    ));
    expect(page1.total_count).toBe(3);
    expect(page1.workflow_runs.map((r) => r.run_number)).toEqual([3, 2]);
    const page2 = await get(`/api/v1/repos/alice/${slug}/actions/runs?page=2&limit=2`, alice.id);
    expect(page2.headers.get("x-total-count")).toBe("3");
    expect(page2.headers.get("Link")).toContain('rel="prev"');
    expect((await jsonBody<WorkflowRunsEnvelope>(page2)).workflow_runs.map((r) => r.run_number)).toEqual([1]);
  });

  it("filters — the status words, the branch→ref expansion, the event, head_sha", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, { index: 1, runStatus: ACTION_STATUS_SUCCESS });
    await seedActionRun(repoId, alice.id, { index: 2, runStatus: ACTION_STATUS_WAITING });
    await seedActionRun(repoId, alice.id, { index: 3, ref: "refs/heads/feature", triggerEvent: "workflow_dispatch" });
    await seedActionRun(repoId, alice.id, { index: 4, commitSha: sha40(0xd001) });

    const names = async (q: string): Promise<number[]> =>
      (await jsonBody<WorkflowRunsEnvelope>(await get(`/api/v1/repos/alice/${slug}/actions/runs${q}`, alice.id))).workflow_runs.map(
        (r) => r.run_number,
      );
    // completed → {success, failure, skipped, cancelled} ranks (the arm's set).
    expect(await names("?status=completed")).toEqual([1]);
    // queued → the WAITING rank — runs 2/3/4 all rest there (index DESC).
    expect(await names("?status=queued")).toEqual([4, 3, 2]);
    expect(await names("?branch=feature")).toEqual([3]);
    expect(await names("?event=workflow_dispatch")).toEqual([3]);
    expect(await names(`?head_sha=${sha40(0xd001)}`)).toEqual([4]);
    expect(await names("")).toHaveLength(4);
  });

  it("actor: a hit filters by trigger user; a miss 404s the ErrUserNotExist text; an invalid status word 400s", async () => {
    const { alice, bob } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, { index: 1, triggerUserId: bob.id });
    await seedActionRun(repoId, alice.id, { index: 2 });

    const hit = (await jsonBody<WorkflowRunsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/runs?actor=bob`, alice.id),
    ));
    expect(hit.workflow_runs.map((r) => r.run_number)).toEqual([1]);

    const miss = await get(`/api/v1/repos/alice/${slug}/actions/runs?actor=ghost`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("user does not exist [uid: 0, name: ghost]");

    const bad = await get(`/api/v1/repos/alice/${slug}/actions/runs?status=bogus`, alice.id);
    expect(bad.status).toBe(400);
    expect(await messageOf(bad)).toBe("invalid status bogus");
  });

  it("pull_requests — the push open-PR arm, the PR-ref arm, the closed/missing arms, and exclude_pull_requests", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const openPr = await seedPullRow(repoId, 1, "feature");
    await seedPullRow(repoId, 2, "gone", { closed: true });
    const pushRun = await seedActionRun(repoId, alice.id, { index: 1, ref: "refs/heads/feature", commitSha: sha40(0xe001) });
    const prRun = await seedActionRun(repoId, alice.id, { index: 2, event: "pull_request", ref: "refs/pull/1/head", commitSha: sha40(0xe002) });
    // A push to a branch with NO open PR takes the empty arm.
    await seedActionRun(repoId, alice.id, { index: 3, ref: "refs/heads/main", event: "push" });

    const api = `https://example.com/api/v1/repos/alice/${slug}`;
    const body = (await jsonBody<WorkflowRunsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/runs`, alice.id),
    ));
    const byNumber = (n: number): WorkflowRunWire => body.workflow_runs.find((r) => r.run_number === n)!;
    // The push arm: the OPEN PR whose head branch matches (the closed one excluded);
    // head.sha carries the RUN's commit sha, base.sha the PR's merge base.
    expect(byNumber(pushRun.run.index).pull_requests).toEqual([
      {
        id: openPr.id,
        number: 1,
        url: `${api}/pulls/1`,
        head: { ref: "feature", sha: sha40(0xe001), repo: { id: Number(repoId), url: api, name: slug } },
        base: { ref: "main", sha: sha40(0xb001), repo: { id: Number(repoId), url: api, name: slug } },
      },
    ]);
    // The PR-ref arm: the PR the run's refs/pull/N/head points at.
    expect(byNumber(prRun.run.index).pull_requests).toEqual([
      {
        id: openPr.id,
        number: 1,
        url: `${api}/pulls/1`,
        head: { ref: "feature", sha: sha40(0xe002), repo: { id: Number(repoId), url: api, name: slug } },
        base: { ref: "main", sha: sha40(0xb001), repo: { id: Number(repoId), url: api, name: slug } },
      },
    ]);
    // A run whose push matches nothing open takes the empty arm.
    expect(byNumber(3).pull_requests).toEqual([]);

    // exclude_pull_requests empties the field on EVERY entry.
    const excluded = (await jsonBody<WorkflowRunsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/runs?exclude_pull_requests=true`, alice.id),
    ));
    expect(excluded.workflow_runs.every((r) => r.pull_requests.length === 0)).toBe(true);
  });

  it("gates: any authed READER lists a public repo (reqReaderCheck, NOT reqOwner); an invisible repo 404s; 401 anonymous", async () => {
    const { alice, bob } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, { index: 1 });
    // bob is NO owner and NO collaborator — yet the runs/jobs pair lists:
    // the route rides addActionsRoutes' reqReaderCheck arm (api.go:992-993).
    const bobRes = await get(`/api/v1/repos/alice/${slug}/actions/runs`, bob.id);
    expect(bobRes.status).toBe(200);
    expect((await jsonBody<WorkflowRunsEnvelope>(bobRes)).total_count).toBe(1);
    // The declared 404s: an unknown repo (anti-enumeration) and 401 anonymous.
    expect((await get("/api/v1/repos/alice/missing/actions/runs", alice.id)).status).toBe(404);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/runs`)).status).toBe(401);
  });
});

describe("repo workflow jobs (GET /repos/{owner}/{repo}/actions/jobs)", () => {
  it("the ActionWorkflowJob wire pins exactly (unclaimed job — no runner, empty steps)", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const seeded = await seedActionRun(repoId, alice.id, {
      index: 1,
      commitSha: sha40(0xf001),
      jobs: [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest", "docker"] }],
    });
    const res = await get(`/api/v1/repos/alice/${slug}/actions/jobs`, alice.id);
    expect(res.status).toBe(200);
    const body = (await jsonBody<WorkflowJobsEnvelope>(res));
    expect(body.total_count).toBe(1);
    const api = `https://example.com/api/v1/repos/alice/${slug}`;
    const html = `https://example.com/alice/${slug}`;
    expect(body.jobs).toEqual([
      {
        id: seeded.jobIds[0],
        url: `${api}/actions/jobs/${seeded.jobIds[0]}`,
        html_url: `${html}/actions/runs/${seeded.run.id}/jobs/${seeded.jobIds[0]}`,
        run_id: seeded.run.id,
        run_url: `${api}/actions/runs/${seeded.run.id}`,
        name: "build",
        labels: ["ubuntu-latest", "docker"],
        run_attempt: 1,
        head_sha: sha40(0xf001),
        head_branch: "main",
        status: "queued",
        steps: [],
        created_at: seeded.jobRows[0]!.created.toISOString(),
        started_at: GO_ZERO,
        completed_at: GO_ZERO,
      },
    ]);
  });

  it("a claimed job renders runner_id/runner_name + the task's steps (number is the LOOP index, convert.go:552)", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const runner = await seedRunner(repoScopeSeed(repoId), "claiming-runner");
    const started = new Date("2026-04-01T10:00:00Z");
    const stopped = new Date("2026-04-01T10:01:00Z");
    const seeded = await seedActionRun(repoId, alice.id, {
      index: 1,
      runStatus: ACTION_STATUS_RUNNING,
      jobs: [{ jobId: "build", name: "build", status: ACTION_STATUS_RUNNING, started }],
    });
    const taskRows = await db()
      .insert(actionTasks)
      .values({
        jobId: seeded.jobIds[0]!,
        attempt: 1,
        runnerId: runner.id,
        status: ACTION_STATUS_RUNNING,
        repoId,
        ownerId: alice.id,
        tokenHash: `task-hash-${actionTaskSeq++}`,
        created: started,
        updated: started,
      })
      .returning()
      .all();
    const taskId = taskRows[0]!.id;
    await db().update(actionRunJobs).set({ taskId }).where(eq(actionRunJobs.id, seeded.jobIds[0]!));
    await db().insert(actionTaskSteps).values([
      { name: "checkout", taskId, index: 0, repoId, status: ACTION_STATUS_SUCCESS, started, stopped, created: started, updated: stopped },
      { name: "build", taskId, index: 1, repoId, status: ACTION_STATUS_RUNNING, started: stopped, stopped: null, created: stopped, updated: stopped },
    ]);

    const body = (await jsonBody<WorkflowJobsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/jobs`, alice.id),
    ));
    const job = body.jobs[0]!;
    expect(job.runner_id).toBe(runner.id);
    expect(job.runner_name).toBe("claiming-runner");
    expect(job.status).toBe("in_progress");
    expect(job.steps).toEqual([
      { name: "checkout", number: 0, status: "completed", conclusion: "success", started_at: started.toISOString(), completed_at: stopped.toISOString() },
      { name: "build", number: 1, status: "in_progress", started_at: stopped.toISOString(), completed_at: GO_ZERO },
    ]);
  });

  it("head_sha/head_branch read the RUN row, not the job's denormalized copy", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const seeded = await seedActionRun(repoId, alice.id, { index: 1, commitSha: sha40(0xf101) });
    await db().update(actionRunJobs).set({ commitSha: sha40(0xffff) }).where(eq(actionRunJobs.id, seeded.jobIds[0]!));
    const body = (await jsonBody<WorkflowJobsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/jobs`, alice.id),
    ));
    expect(body.jobs[0]!.head_sha).toBe(sha40(0xf101));
  });

  it("sort/order — the default id ASC (order IGNORED without sort), desc, and the two 422 texts in upstream's arm order", async () => {
    const { alice } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    for (const n of [1, 2, 3]) {
      await seedActionRun(repoId, alice.id, { index: n, jobs: [{ jobId: `j${n}` }] });
    }
    const ids = async (q: string): Promise<number[]> => {
      const res = await get(`/api/v1/repos/alice/${slug}/actions/jobs${q}`, alice.id);
      expect(res.status).toBe(200);
      return (await jsonBody<WorkflowJobsEnvelope>(res)).jobs.map((j) => j.id);
    };
    const [first, second, third] = await ids("");
    expect((first ?? 0) < (second ?? 0)).toBe(true);
    expect((second ?? 0) < (third ?? 0)).toBe(true);
    // sort ABSENT → the default order even with order=desc (ResolveSortOrder
    // returns early, utils/sort.go:20-22).
    expect(await ids("?order=desc")).toEqual([first, second, third]);
    expect(await ids("?sort=id&order=desc")).toEqual([third, second, first]);

    // The 422 arms — ORDER resolves BEFORE mode, so a bogus pair takes the
    // ORDER text (utils/sort.go:26-36).
    const badMode = await get(`/api/v1/repos/alice/${slug}/actions/jobs?sort=bogus`, alice.id);
    expect(badMode.status).toBe(422);
    expect(await messageOf(badMode)).toBe('Invalid sort mode: "bogus"');
    const badOrder = await get(`/api/v1/repos/alice/${slug}/actions/jobs?sort=id&order=bogus`, alice.id);
    expect(badOrder.status).toBe(422);
    expect(await messageOf(badOrder)).toBe('Invalid sort order: "bogus"');
    const both = await get(`/api/v1/repos/alice/${slug}/actions/jobs?sort=bogus&order=bogus`, alice.id);
    expect(await messageOf(both)).toBe('Invalid sort order: "bogus"');
  });

  it("the status filter, pagination, and the gates (reader lists; 404 unknown repo; 401 anonymous)", async () => {
    const { alice, bob } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, {
      index: 1,
      runStatus: ACTION_STATUS_FAILURE,
      jobs: [{ jobId: "build", status: ACTION_STATUS_FAILURE }],
    });
    await seedActionRun(repoId, alice.id, { index: 2 });

    const failed = (await jsonBody<WorkflowJobsEnvelope>(
      await get(`/api/v1/repos/alice/${slug}/actions/jobs?status=failure`, alice.id),
    ));
    expect(failed.total_count).toBe(1);
    expect(failed.jobs[0]!.status).toBe("completed");
    expect(failed.jobs[0]!.conclusion).toBe("failure");

    expect((await get(`/api/v1/repos/alice/${slug}/actions/jobs?limit=1&page=2`, alice.id)).headers.get("x-total-count")).toBe("2");
    // bob — a plain authed reader — lists (the reqReaderCheck arm).
    expect((await get(`/api/v1/repos/alice/${slug}/actions/jobs`, bob.id)).status).toBe(200);
    expect((await get("/api/v1/repos/alice/missing/actions/jobs", alice.id)).status).toBe(404);
    expect((await get(`/api/v1/repos/alice/${slug}/actions/jobs`)).status).toBe(401);
  });
});

describe("org workflow runs/jobs (GET /orgs/{org}/actions/runs|jobs)", () => {
  it("gates: owner AND plain member list (reqOrgMembership, NOT ownership); a non-member 403s; missing org 404s; 401 anonymous", async () => {
    const org = await seedOrg("acme");
    const { repoId } = await seedOrgRepo("acme", org.orgId);
    await seedActionRun(repoId, org.orgId, { index: 1 });

    const memberRes = await get("/api/v1/orgs/acme/actions/runs", org.member.id);
    expect(memberRes.status).toBe(200);
    expect((await jsonBody<WorkflowRunsEnvelope>(memberRes)).total_count).toBe(1);
    expect((await get("/api/v1/orgs/acme/actions/runs", org.owner.id)).status).toBe(200);

    const outsider = await get("/api/v1/orgs/acme/actions/runs", org.outsider.id);
    expect(outsider.status).toBe(403);
    expect(await messageOf(outsider)).toBe("Must be an organization member");
    const outsiderJobs = await get("/api/v1/orgs/acme/actions/jobs", org.outsider.id);
    expect(outsiderJobs.status).toBe(403);
    expect(await messageOf(outsiderJobs)).toBe("Must be an organization member");

    expect((await get("/api/v1/orgs/missing/actions/runs", org.owner.id)).status).toBe(404);
    expect((await get("/api/v1/orgs/acme/actions/runs")).status).toBe(401);
    expect((await get("/api/v1/orgs/acme/actions/jobs")).status).toBe(401);
  });

  it("the accessible-repos subquery: a member sees only the org repos they can view; the owner and the site admin see all", async () => {
    const org = await seedOrg("acme");
    const publicRepo = await seedOrgRepo("acme", org.orgId, "public");
    const privateRepo = await seedOrgRepo("acme", org.orgId, "private");
    await seedActionRun(publicRepo.repoId, org.orgId, { index: 1 });
    await seedActionRun(privateRepo.repoId, org.orgId, { index: 1 });

    const ownerBody = (await jsonBody<WorkflowRunsEnvelope>(
      await get("/api/v1/orgs/acme/actions/runs", org.owner.id),
    ));
    expect(ownerBody.total_count).toBe(2);
    // The member's subquery covers the public repo only — the private repo's
    // run filters away from BOTH the page and the total.
    const memberBody = (await jsonBody<WorkflowRunsEnvelope>(
      await get("/api/v1/orgs/acme/actions/runs", org.member.id),
    ));
    expect(memberBody.total_count).toBe(1);
    expect(memberBody.workflow_runs).toHaveLength(1);
    expect((memberBody.workflow_runs[0]!.repository as { id: number }).id).toBe(Number(publicRepo.repoId));
    // The site admin's subquery is nil (DoerIsSiteAdminFullAccess) — all rows.
    expect((await jsonBody<WorkflowRunsEnvelope>(await get("/api/v1/orgs/acme/actions/runs", org.admin.id))).total_count).toBe(2);

    // The jobs twin carries the same filter.
    const memberJobs = (await jsonBody<WorkflowJobsEnvelope>(
      await get("/api/v1/orgs/acme/actions/jobs", org.member.id),
    ));
    expect(memberJobs.total_count).toBe(1);
    expect((await jsonBody<WorkflowJobsEnvelope>(await get("/api/v1/orgs/acme/actions/jobs", org.owner.id))).total_count).toBe(2);
  });

  it("the empty envelope and the owner-scope id-DESC order across repos", async () => {
    const org = await seedOrg("acme");
    const repoA = await seedOrgRepo("acme", org.orgId);
    const repoB = await seedOrgRepo("acme", org.orgId);
    const first = await seedActionRun(repoA.repoId, org.orgId, { index: 1 });
    const second = await seedActionRun(repoB.repoId, org.orgId, { index: 1 });
    const body = (await jsonBody<WorkflowRunsEnvelope>(await get("/api/v1/orgs/acme/actions/runs", org.owner.id)));
    // No repo scope → the global id DESC order (run_list.go:150-152).
    expect(body.workflow_runs.map((r) => r.id)).toEqual([second.run.id, first.run.id]);
    // A member-less org listing a run-less owner scope: the empty shape.
    const ghost = await seedOrg("ghost-org");
    expect((await jsonBody(await get("/api/v1/orgs/ghost-org/actions/runs", ghost.owner.id))).total_count).toBe(0);
  });
});

describe("user workflow runs/jobs (GET /user/actions/runs|jobs)", () => {
  it("the doer's scope covers their repos' rows; siblings stay invisible; 401 anonymous", async () => {
    const { alice, bob } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    const seeded = await seedActionRun(repoId, alice.id, { index: 1 });

    const aliceBody = (await jsonBody<WorkflowRunsEnvelope>(await get("/api/v1/user/actions/runs", alice.id)));
    expect(aliceBody.total_count).toBe(1);
    expect(aliceBody.workflow_runs[0]!.id).toBe(seeded.run.id);
    // bob's owner scope is a DIFFERENT store.
    expect((await jsonBody<WorkflowRunsEnvelope>(await get("/api/v1/user/actions/runs", bob.id))).total_count).toBe(0);

    const jobs = (await jsonBody<WorkflowJobsEnvelope>(await get("/api/v1/user/actions/jobs", alice.id)));
    expect(jobs.total_count).toBe(1);
    expect(jobs.jobs[0]!.run_id).toBe(seeded.run.id);
    expect((await jsonBody<WorkflowJobsEnvelope>(await get("/api/v1/user/actions/jobs", bob.id))).total_count).toBe(0);

    expect((await get("/api/v1/user/actions/runs")).status).toBe(401);
    expect((await get("/api/v1/user/actions/jobs")).status).toBe(401);
  });

  it("the user jobs sort/order rides the same JobOrderByMap; the status filter applies", async () => {
    const { alice } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, { index: 1, runStatus: ACTION_STATUS_SUCCESS, jobs: [{ jobId: "a", status: ACTION_STATUS_SUCCESS }] });
    await seedActionRun(repoId, alice.id, { index: 2, jobs: [{ jobId: "b" }] });
    const desc = (await jsonBody<WorkflowJobsEnvelope>(await get("/api/v1/user/actions/jobs?sort=id&order=desc", alice.id)));
    const asc = (await jsonBody<WorkflowJobsEnvelope>(await get("/api/v1/user/actions/jobs", alice.id)));
    expect(desc.jobs.map((j) => j.id)).toEqual([...asc.jobs.map((j) => j.id)].reverse());
    const done = (await jsonBody<WorkflowJobsEnvelope>(await get("/api/v1/user/actions/jobs?status=success", alice.id)));
    expect(done.total_count).toBe(1);
    const bad = await get("/api/v1/user/actions/jobs?sort=nope", alice.id);
    expect(bad.status).toBe(422);
    expect(await messageOf(bad)).toBe('Invalid sort mode: "nope"');
  });
});
