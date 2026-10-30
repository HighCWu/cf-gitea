/**
 * The ADMIN Actions family on real D1 (routes/admin-actions.ts — the board's
 * P1-12 landing, the `/admin/actions` group's 7 contract operations:
 * routers/api/v1/api.go:1856-1867):
 *
 *   - getAdminRunners / adminCreateRunnerRegistrationToken / getAdminRunner /
 *     deleteAdminRunner / updateAdminRunner (admin/runners.go:14-126 — the
 *     admin bindings of shared/runners.go with ownerID=0/repoID=0);
 *   - listAdminWorkflowRuns / listAdminWorkflowJobs (admin/action.go:12-103 —
 *     shared.ListRuns/ListJobs with (0, 0, nil)).
 *
 * Standalone mount per the tier2-extras.test.ts convention (the routes ARE
 * registered in router.ts by the orchestrator after this batch — the module
 * header carries the one-liner). The pins land per op:
 *
 *   - THE ADMIN POLARITY (the suite's reason to exist beside the P1-7 twins):
 *     the list is the instance-wide census — repo-scoped, org/user-scoped,
 *     user-scoped AND global rows all list, which NO twin scope can show;
 *     the lookup is ID-only with EditableInContext(0, 0)=true
 *     (runner.go:158-165), so an org-scoped runner that 404s "No permission…"
 *     in a repo context GETs/PATCHes/DELETEs fine here and the twins' foreign
 *     arm DOES NOT EXIST (only the not-exist 404 text remains);
 *   - the registration token is the GLOBAL (0, '') scope — a distinct row
 *     from any repo/owner token, reused while active;
 *   - the runs/jobs lists are the UNRESTRICTED census over every repo (the
 *     accessibility subquery is nil at ownerID 0, repo_list.go:806) in the
 *     non-repo ToOrders arm (id ordering, run_list.go:150-152);
 *   - THE GATES: 401 `token is required` anonymous; 403 `user should be the
 *     site admin` for a signed-in non-admin on every op (the /admin group's
 *     reqSiteAdmin, api.go:343-347 — runtime-only codes, the contract
 *     documents neither on these 7 ops).
 *
 * Upstream behavior pins mirrored by these assertions are cited in the route
 * module header and inline per test.
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
  actionRunnerTokens,
  actionTaskSteps,
  actionTasks,
  actionTasksVersions,
  repositories,
  users,
} from "../../db/schema";
import {
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  insertActionRun,
  type RunRow,
  type RunnerRow,
} from "../../services/actions/model";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerAdminActionsRoutes } from "./admin-actions";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
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
    "user_redirects",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (hooks-scopes.test.ts's pattern):
// tokens bind to seeded D1 users, so the reqSiteAdmin gate reads what the
// seeds wrote. Ids are NEVER hardcoded — every test reads the seeded ids back.
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
  registerAdminActionsRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const post = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "POST", headers: userId === undefined ? {} : authHeaders(userId) });

const del = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: userId === undefined ? {} : authHeaders(userId) });

const patch = (path: string, body: unknown, userId?: number): Promise<Response> =>
  router()(path, { method: "PATCH", headers: authHeaders(userId ?? 0), body: JSON.stringify(body) });

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

const messageOf = async (res: Response): Promise<string> => (await jsonBody<{ message: string }>(res)).message;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** The canonical world: alice (owns a repo), bob (a plain second user — the
 *  403 arm's actor), the site admin (every op's caller). */
async function seedWorld(): Promise<{ alice: SeededUser; bob: SeededUser; admin: SeededUser }> {
  const alice = await seedUser("alice");
  const bob = await seedUser("bob");
  const admin = await seedUser("site-admin", true);
  return { alice, bob, admin };
}

let repoSeq = 9400;

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

/** One org row (orgs ARE users rows) — enough for an owner-scoped runner
 *  encoding ({ownerId, repoId: ""}). */
async function seedOrg(name: string): Promise<{ orgId: number }> {
  const org = await db()
    .insert(users)
    .values({
      username: name,
      usernameLower: name.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "org",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    })
    .returning()
    .all();
  const orgRow = org[0];
  if (orgRow === undefined) throw new Error("org seed failed");
  return { orgId: orgRow.id };
}

const T_ACTIVE = 0;
const T_IDLE = 30_000;
const T_OFFLINE = 120_000;

let runnerSeq = 9500;

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

function repoScopeSeed(repoId: string): { ownerId: number; repoId: string } {
  return { ownerId: 0, repoId };
}

function ownerScopeSeed(ownerId: number): { ownerId: number; repoId: string } {
  return { ownerId, repoId: "" };
}

/** The GLOBAL scope encoding — the admin family's own registry arm. */
function globalScopeSeed(): { ownerId: number; repoId: string } {
  return { ownerId: 0, repoId: "" };
}

interface RunnerWire {
  id: number;
  name: string;
  status: "online" | "offline";
  busy: boolean;
  disabled: boolean;
  ephemeral: boolean;
  labels: Array<{ id: number; name: string; type: string }>;
}

interface RunnerListWire {
  runners: RunnerWire[];
  total_count: number;
}

// ---------------------------------------------------------------------------
// Runs/jobs seeds — the LANDED insertion seam (the P1-7 suite's pattern).
// ---------------------------------------------------------------------------

/** Distinct 40-char shas (the hex rendering keeps them column-typical). */
const sha40 = (n: number): string => n.toString(16).padStart(40, "0");

const GO_ZERO = "0001-01-01T00:00:00Z";

const WORKFLOW_PAYLOAD = new TextEncoder().encode(
  "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
);

let actionRunSeq = 1;
let actionTaskSeq = 7000;

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

/** One run through the LANDED insertion seam, then the caller's status
 *  overrides settled with direct updates. */
async function seedActionRun(repoId: string, ownerId: number, seed: ActionRunSeed = {}): Promise<{ run: RunRow; attemptId: number; jobIds: number[] }> {
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
  return { run, attemptId: attempt.id, jobIds: jobRows.map((j) => j.id) };
}

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

// ---------------------------------------------------------------------------
// THE GATES — 401 anonymous + 403 non-admin on every op (the /admin group's
// reqToken → reqSiteAdmin chain; runtime-only codes, the contract documents
// neither on these 7 ops).
// ---------------------------------------------------------------------------

describe("gates (the /admin group's reqToken → reqSiteAdmin)", () => {
  it("401 anonymous on all seven ops", async () => {
    await seedWorld();
    expect((await get("/api/v1/admin/actions/runners")).status).toBe(401);
    expect((await post("/api/v1/admin/actions/runners/registration-token")).status).toBe(401);
    expect((await get("/api/v1/admin/actions/runners/1")).status).toBe(401);
    expect((await del("/api/v1/admin/actions/runners/1")).status).toBe(401);
    expect((await patch("/api/v1/admin/actions/runners/1", { disabled: true })).status).toBe(401);
    expect((await get("/api/v1/admin/actions/runs")).status).toBe(401);
    expect((await get("/api/v1/admin/actions/jobs")).status).toBe(401);
  });

  it("403 'user should be the site admin' for a signed-in NON-admin on all seven ops (api.go:343-347)", async () => {
    const { bob } = await seedWorld();
    const base = "/api/v1/admin/actions";
    for (const res of await Promise.all([
      get(`${base}/runners`, bob.id),
      post(`${base}/runners/registration-token`, bob.id),
      get(`${base}/runners/1`, bob.id),
      del(`${base}/runners/1`, bob.id),
      patch(`${base}/runners/1`, { disabled: true }, bob.id),
      get(`${base}/runs`, bob.id),
      get(`${base}/jobs`, bob.id),
    ])) {
      expect(res.status).toBe(403);
      expect(await messageOf(res)).toBe("user should be the site admin");
    }
  });

  it("the site admin passes the gate on every op", async () => {
    const { admin } = await seedWorld();
    expect((await get("/api/v1/admin/actions/runners", admin.id)).status).toBe(200);
    expect((await post("/api/v1/admin/actions/runners/registration-token", admin.id)).status).toBe(200);
    expect((await get("/api/v1/admin/actions/runners/1", admin.id)).status).toBe(404); // gate passed, runner missing
    expect((await del("/api/v1/admin/actions/runners/1", admin.id)).status).toBe(404);
    expect((await patch("/api/v1/admin/actions/runners/1", { disabled: true }, admin.id)).status).toBe(404);
    expect((await get("/api/v1/admin/actions/runs", admin.id)).status).toBe(200);
    expect((await get("/api/v1/admin/actions/jobs", admin.id)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// RUNNERS CRUD + REGISTRATION TOKEN (5 ops — admin/runners.go:14-126).
// ---------------------------------------------------------------------------

describe("admin runners (GET/POST/DELETE/PATCH /admin/actions/runners)", () => {
  it("GET list is the instance-wide census: repo-scoped, org-scoped, user-scoped AND global rows ALL list (the twins' scope pin inverted)", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    const org = await seedOrg("acme");
    const now = Date.now();
    // The GLOBAL scope kind — the encoding only the admin family writes to
    // ((0, '') — the UI page's own registry arm).
    await seedRunner(globalScopeSeed(), "g-global", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_ACTIVE),
    });
    const repoRunner = await seedRunner(repoScopeSeed(repoId), "r-repo", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_IDLE),
    });
    const orgRunner = await seedRunner(ownerScopeSeed(org.orgId), "o-org", {
      lastOnline: new Date(now - T_OFFLINE),
      lastActive: new Date(now - T_OFFLINE),
    });
    // A user-scoped runner (alice's own owner scope) — the fourth scope kind.
    await seedRunner(ownerScopeSeed(alice.id), "u-user", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_ACTIVE),
    });

    const res = await get("/api/v1/admin/actions/runners", admin.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("4");
    const wire = await jsonBody<RunnerListWire>(res);
    expect(wire.total_count).toBe(4);
    // The default status-rank order (active → idle → offline; runner.go:315):
    // the active global, the active user runner, the idle repo runner, the
    // offline org runner — alphabetically only WITHIN a rank is not pinned,
    // the tiebreak is last_online desc + id.
    expect(wire.runners.map((r) => r.name)).toEqual(["g-global", "u-user", "r-repo", "o-org"]);
    expect(wire.runners.map((r) => [r.status, r.busy])).toEqual([
      ["online", true],
      ["online", true],
      ["online", false],
      ["offline", false],
    ]);
    expect(wire.runners[3]?.id).toBe(orgRunner.id);
    // The census rows keep their scope encodings (the store is untouched).
    expect((await jsonBody<RunnerWire>(await get(`/api/v1/admin/actions/runners/${repoRunner.id}`, admin.id))).name).toBe("r-repo");
  });

  it("the ActionRunner wire pins exactly (labels index as ids, type 'custom') and pagination rides page/limit", async () => {
    const { admin } = await seedWorld();
    const now = Date.now();
    const first = await seedRunner(globalScopeSeed(), "a-first", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_ACTIVE),
      agentLabels: ["fedora-latest", "docker"],
      ephemeral: true,
    });
    await seedRunner(globalScopeSeed(), "b-second", {
      lastOnline: new Date(now),
      lastActive: new Date(now - T_ACTIVE),
    });

    const page1 = await get("/api/v1/admin/actions/runners?limit=1&page=1", admin.id);
    expect(page1.status).toBe(200);
    expect(page1.headers.get("x-total-count")).toBe("2");
    const wire = await jsonBody<RunnerListWire>(page1);
    expect(wire.runners).toHaveLength(1);
    expect(wire.runners[0]).toEqual({
      id: first.id,
      name: "a-first",
      status: "online",
      busy: true,
      disabled: false,
      ephemeral: true,
      labels: [
        { id: 0, name: "fedora-latest", type: "custom" },
        { id: 1, name: "docker", type: "custom" },
      ],
    });

    const page2 = await get("/api/v1/admin/actions/runners?limit=1&page=2", admin.id);
    expect(page2.headers.get("x-total-count")).toBe("2");
    expect(page2.headers.get("Link")).toContain('rel="prev"');
    expect((await jsonBody<RunnerListWire>(page2)).runners[0]?.name).toBe("b-second");
  });

  it("the disabled query filter — true/false, an unparsable value parses FALSE (FormOptionalBool)", async () => {
    const { admin } = await seedWorld();
    await seedRunner(globalScopeSeed(), "enabled-1");
    await seedRunner(globalScopeSeed(), "enabled-2");
    await seedRunner(repoScopeSeed("9717"), "paused", { isDisabled: true });

    const names = async (q: string): Promise<string[]> =>
      (await jsonBody<RunnerListWire>(await get(`/api/v1/admin/actions/runners${q}`, admin.id))).runners.map((r) => r.name);
    expect(await names("")).toEqual(["enabled-1", "enabled-2", "paused"]);
    expect(await names("?disabled=false")).toEqual(["enabled-1", "enabled-2"]);
    expect(await names("?disabled=true")).toEqual(["paused"]);
    // strconv.ParseBool's ignored-error arm (base_form.go:76): "yes" parses
    // as false, so the filter selects the NON-disabled rows.
    expect(await names("?disabled=yes")).toEqual(["enabled-1", "enabled-2"]);
  });

  it("POST registration-token 200s {token} at the GLOBAL (0,'') scope, reuses the active token, and stays distinct from a repo-scope token", async () => {
    const { admin } = await seedWorld();

    const first = await post("/api/v1/admin/actions/runners/registration-token", admin.id);
    expect(first.status).toBe(200);
    const body = await jsonBody<{ token: string }>(first);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);

    // GetOrCreateActiveRunnerToken REUSES the active token (a POST is not a
    // reset — runner_token.go:127-134).
    const second = await jsonBody<{ token: string }>(await post("/api/v1/admin/actions/runners/registration-token", admin.id));
    expect(second.token).toBe(body.token);

    // The stored row carries the GLOBAL scope (owner_id 0 + the '' repo
    // sentinel) — the global registry is its own row, distinct from any
    // repo/owner scope the twins mint into.
    const stored = await db().select().from(actionRunnerTokens).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ownerId: 0, repoId: "", isActive: true });
    expect(body.token).not.toBe("");
  });

  it("GET by id 200s a REPO-scoped runner and an ORG-scoped runner alike (EditableInContext(0,0)=true — no foreign arm); the miss is the not-exist text; non-numeric id is the id-0 miss", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    const org = await seedOrg("acme");
    const repoRunner = await seedRunner(repoScopeSeed(repoId), "repo-runner", { agentLabels: ["ubuntu-latest"] });
    const orgRunner = await seedRunner(ownerScopeSeed(org.orgId), "org-runner");

    // The org-scoped runner that 404s "No permission…" in the REPO context
    // (the twins' EditableInContext arm) GETs fine at the admin scope.
    const gotOrg = await get(`/api/v1/admin/actions/runners/${orgRunner.id}`, admin.id);
    expect(gotOrg.status).toBe(200);
    expect(await jsonBody<RunnerWire>(gotOrg)).toMatchObject({ id: orgRunner.id, name: "org-runner", labels: [] });

    const gotRepo = await get(`/api/v1/admin/actions/runners/${repoRunner.id}`, admin.id);
    expect(gotRepo.status).toBe(200);
    // Seeded heartbeats are fresh — the runner renders online/busy.
    expect(await jsonBody<RunnerWire>(gotRepo)).toEqual({
      id: repoRunner.id,
      name: "repo-runner",
      status: "online",
      busy: true,
      disabled: false,
      ephemeral: false,
      labels: [{ id: 0, name: "ubuntu-latest", type: "custom" }],
    });

    // The ONLY 404 is GetRunnerByID's not-exist text
    // (shared/runners.go:75-77 + runner.go:336).
    const miss = await get("/api/v1/admin/actions/runners/999999", admin.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("runner with id 999999: resource does not exist");

    // PathParamInt64's failure arm is 0 (base_path.go:35-38) → the id-0 miss.
    const nonNumeric = await get("/api/v1/admin/actions/runners/abc", admin.id);
    expect(nonNumeric.status).toBe(404);
    expect(await messageOf(nonNumeric)).toBe("runner with id 0: resource does not exist");
  });

  it("DELETE 204 removes across scopes; the second delete is the not-exist 404", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    const org = await seedOrg("acme");
    const repoRunner = await seedRunner(repoScopeSeed(repoId), "doomed");
    const orgRunner = await seedRunner(ownerScopeSeed(org.orgId), "org-doomed");

    expect((await del(`/api/v1/admin/actions/runners/${repoRunner.id}`, admin.id)).status).toBe(204);
    expect((await del(`/api/v1/admin/actions/runners/${orgRunner.id}`, admin.id)).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM action_runners").first<{ n: number }>())?.n).toBe(0);
    const miss = await del(`/api/v1/admin/actions/runners/${repoRunner.id}`, admin.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe(`runner with id ${repoRunner.id}: resource does not exist`);
  });

  it("PATCH 200 flips disabled and re-renders (also on an org-scoped row); the idempotent PATCH no-ops; 422 on a missing disabled AFTER the 404 arms", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    const org = await seedOrg("acme");
    const runner = await seedRunner(repoScopeSeed(repoId), "flip-me");
    const orgRunner = await seedRunner(ownerScopeSeed(org.orgId), "org-flip");

    const flip = await patch(`/api/v1/admin/actions/runners/${runner.id}`, { disabled: true }, admin.id);
    expect(flip.status).toBe(200);
    expect(await jsonBody<RunnerWire>(flip)).toMatchObject({ id: runner.id, disabled: true });
    // SetRunnerDisabled's real flip bumps the scope's task version
    // (runner.go:364) — the cascade plants the missing scope rows.
    const bumped = await db().select({ n: count() }).from(actionTasksVersions).where(eq(actionTasksVersions.repoId, repoId));
    expect(bumped[0]?.n).toBeGreaterThan(0);

    // The ADMIN polarity on the twins' foreign arm: an ORG-scoped runner
    // PATCHes fine (EditableInContext(0,0)=true) and bumps its owner scope.
    const orgFlip = await patch(`/api/v1/admin/actions/runners/${orgRunner.id}`, { disabled: true }, admin.id);
    expect(orgFlip.status).toBe(200);
    expect(await jsonBody<RunnerWire>(orgFlip)).toMatchObject({ id: orgRunner.id, disabled: true });

    // The equal-value PATCH returns early (runner.go:355-357) — the version
    // table does NOT grow (the earlier flips' rows are all there are).
    const beforeRows = await db().select({ n: count() }).from(actionTasksVersions);
    const fresh = await seedRunner(repoScopeSeed(repoId), "fresh-scope");
    const same = await patch(`/api/v1/admin/actions/runners/${fresh.id}`, { disabled: false }, admin.id);
    expect(same.status).toBe(200);
    const freshRows = await db().select({ n: count() }).from(actionTasksVersions);
    expect(freshRows[0]?.n).toBe(beforeRows[0]?.n);

    // Upstream order: the 404 arms fire BEFORE the Disabled-nil 422
    // (shared/runners.go:124-133) — a missing runner 404s even with {}.
    const missingWithEmptyBody = await patch("/api/v1/admin/actions/runners/999999", {}, admin.id);
    expect(missingWithEmptyBody.status).toBe(404);
    const noDisabled = await patch(`/api/v1/admin/actions/runners/${runner.id}`, {}, admin.id);
    expect(noDisabled.status).toBe(422);
    expect(await messageOf(noDisabled)).toBe("[Disabled]: Required");
  });
});

// ---------------------------------------------------------------------------
// RUNS/JOBS LISTS (2 ops — admin/action.go:12-103 over shared.ListRuns and
// shared.ListJobs with (0, 0, nil)).
// ---------------------------------------------------------------------------

describe("admin workflow runs (GET /admin/actions/runs)", () => {
  it("200 with the empty envelope on an empty store (the M3-independent premise)", async () => {
    const { admin } = await seedWorld();
    const res = await get("/api/v1/admin/actions/runs", admin.id);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ workflow_runs: [], total_count: 0 });
    expect(res.headers.get("x-total-count")).toBe("0");
  });

  it("the unrestricted census: runs from DIFFERENT owners' repos all list in the global id DESC order (run_list.go:150-152)", async () => {
    const { alice, bob, admin } = await seedWorld();
    const repoA = await seedRepo(alice);
    const repoB = await seedRepo(bob);
    // Repo A's run carries the HIGHER per-repo index but the LOWER id — the
    // non-repo order is id DESC, NOT the repo-scoped index DESC.
    const first = await seedActionRun(repoA.repoId, alice.id, { index: 9 });
    const second = await seedActionRun(repoB.repoId, bob.id, { index: 1 });

    const res = await get("/api/v1/admin/actions/runs", admin.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<WorkflowRunsEnvelope>(res);
    expect(body.total_count).toBe(2);
    expect(body.workflow_runs.map((r) => r.id)).toEqual([second.run.id, first.run.id]);
    // Both owners' rows render with their OWN repository embed.
    expect(body.workflow_runs.map((r) => (r.repository as { full_name: string }).full_name).sort()).toEqual(
      [`alice/${repoA.slug}`, `bob/${repoB.slug}`].sort(),
    );
  });

  it("the ActionWorkflowRun wire pins exactly — URLs, the attempt mirror, the ZERO-permission repository embed", async () => {
    const { alice, admin } = await seedWorld();
    const { slug, repoId } = await seedRepo(alice);
    const sha = sha40(0xc001);
    const seeded = await seedActionRun(repoId, alice.id, { commitSha: sha, title: "add ci", triggerUserId: admin.id });
    const res = await get("/api/v1/admin/actions/runs", admin.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<WorkflowRunsEnvelope>(res);
    expect(body.total_count).toBe(1);
    const api = `https://example.com/api/v1/repos/alice/${slug}`;
    const html = `https://example.com/alice/${slug}`;
    const run = body.workflow_runs[0]!;
    // The embeds (actor/trigger_actor/repository) are the toApiUser /
    // toApiRepository renders — their exact shapes are the serializer
    // suites' pins; this module pins the threading (login, the right repo,
    // the ZERO permission block) beside the run's OWN exact wire fields.
    const { actor, trigger_actor, repository, ...runFields } = run;
    expect(runFields).toEqual({
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
      path: ".gitea/workflows/ci.yml@refs/heads/main",
      event: "push",
      run_attempt: 1,
      run_number: seeded.run.index,
      head_sha: sha,
      head_branch: "main",
      status: "queued",
      conclusion: undefined,
      pull_requests: [],
      created_at: seeded.run.created.toISOString(),
      updated_at: seeded.run.updated.toISOString(),
      started_at: GO_ZERO,
      completed_at: GO_ZERO,
    });
    // The seeded trigger user is the admin — the run row's trigger user
    // renders BOTH actor and trigger_actor when the attempt mirrors it
    // (the actor≠trigger_actor divergence is the service suite's pin).
    expect(actor?.login).toBe("site-admin");
    expect(trigger_actor?.login).toBe("site-admin");
    expect(repository).toMatchObject({
      id: Number(repoId),
      full_name: `alice/${slug}`,
      // ToRepo with AccessModeNone (convert.go:338) — the zero block,
      // doer-independent (repository.go:41-45).
      permissions: { admin: false, push: false, pull: false },
    });
  });

  it("filters — status words, branch expansion, event, head_sha, actor hit/miss; the invalid status word 400s", async () => {
    const { alice, bob, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, { index: 1, runStatus: ACTION_STATUS_SUCCESS });
    await seedActionRun(repoId, alice.id, { index: 2, runStatus: ACTION_STATUS_WAITING });
    await seedActionRun(repoId, alice.id, { index: 3, ref: "refs/heads/feature", triggerEvent: "workflow_dispatch" });
    await seedActionRun(repoId, alice.id, { index: 4, commitSha: sha40(0xd001) });
    await seedActionRun(repoId, alice.id, { index: 5, triggerUserId: bob.id });

    const numbers = async (q: string): Promise<number[]> =>
      (await jsonBody<WorkflowRunsEnvelope>(await get(`/api/v1/admin/actions/runs${q}`, admin.id))).workflow_runs.map(
        (r) => r.run_number,
      );
    // completed → {success, failure, skipped, cancelled} ranks (the arm's set).
    expect(await numbers("?status=completed")).toEqual([1]);
    // queued → the WAITING rank — runs 2 through 5, since every run the
    // insertion seam plants without an override IS waiting (queued) until a
    // runner picks it; only run 1's SUCCESS rank falls out (id DESC order).
    expect(await numbers("?status=queued")).toEqual([5, 4, 3, 2]);
    expect(await numbers("?branch=feature")).toEqual([3]);
    expect(await numbers("?event=workflow_dispatch")).toEqual([3]);
    expect(await numbers(`?head_sha=${sha40(0xd001)}`)).toEqual([4]);
    expect(await numbers("?actor=bob")).toEqual([5]);
    expect(await numbers("")).toHaveLength(5);

    // The actor miss is ErrUserNotExist's text (user.go:45-49).
    const actorMiss = await get("/api/v1/admin/actions/runs?actor=ghost", admin.id);
    expect(actorMiss.status).toBe(404);
    expect(await messageOf(actorMiss)).toBe("user does not exist [uid: 0, name: ghost]");

    // The invalid status word is the shared 400 (shared/action.go:186-192).
    const bad = await get("/api/v1/admin/actions/runs?status=bogus", admin.id);
    expect(bad.status).toBe(400);
    expect(await messageOf(bad)).toBe("invalid status bogus");
  });

  it("pagination rides page/limit with the total-count header", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    for (const n of [1, 2, 3]) {
      await seedActionRun(repoId, alice.id, { index: n, title: `run ${n}` });
    }
    const page1 = await get("/api/v1/admin/actions/runs?page=1&limit=2", admin.id);
    expect(page1.status).toBe(200);
    expect(page1.headers.get("x-total-count")).toBe("3");
    const body = await jsonBody<WorkflowRunsEnvelope>(page1);
    expect(body.workflow_runs.map((r) => r.run_number)).toEqual([3, 2]);
    const page2 = await get("/api/v1/admin/actions/runs?page=2&limit=2", admin.id);
    expect(page2.headers.get("Link")).toContain('rel="prev"');
    expect((await jsonBody<WorkflowRunsEnvelope>(page2)).workflow_runs.map((r) => r.run_number)).toEqual([1]);
  });
});

describe("admin workflow jobs (GET /admin/actions/jobs)", () => {
  it("the unrestricted census over every repo's jobs; the claimed-job wire pins (runner_id/runner_name + the task's steps, number is the LOOP index)", async () => {
    const { alice, bob, admin } = await seedWorld();
    const repoA = await seedRepo(alice);
    const repoB = await seedRepo(bob);

    const claimed = await seedActionRun(repoA.repoId, alice.id, {
      index: 1,
      commitSha: sha40(0xf001),
      runStatus: ACTION_STATUS_RUNNING,
      jobs: [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest", "docker"], status: ACTION_STATUS_RUNNING, started: new Date("2026-04-01T10:00:00Z") }],
    });
    const claimingRunner = await seedRunner(repoScopeSeed(repoA.repoId), "claiming-runner");
    const started = new Date("2026-04-01T10:00:00Z");
    const stopped = new Date("2026-04-01T10:01:00Z");
    const taskRows = await db()
      .insert(actionTasks)
      .values({
        jobId: claimed.jobIds[0]!,
        attempt: 1,
        runnerId: claimingRunner.id,
        status: ACTION_STATUS_RUNNING,
        repoId: repoA.repoId,
        ownerId: alice.id,
        tokenHash: `task-hash-${actionTaskSeq++}`,
        created: started,
        updated: started,
      })
      .returning()
      .all();
    const taskId = taskRows[0]!.id;
    await db().update(actionRunJobs).set({ taskId }).where(eq(actionRunJobs.id, claimed.jobIds[0]!));
    await db().insert(actionTaskSteps).values([
      { name: "checkout", taskId, index: 0, repoId: repoA.repoId, status: ACTION_STATUS_SUCCESS, started, stopped, created: started, updated: stopped },
      { name: "build", taskId, index: 1, repoId: repoA.repoId, status: ACTION_STATUS_RUNNING, started: stopped, stopped: null, created: stopped, updated: stopped },
    ]);

    const other = await seedActionRun(repoB.repoId, bob.id, { index: 1 });

    const res = await get("/api/v1/admin/actions/jobs", admin.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await jsonBody<WorkflowJobsEnvelope>(res);
    expect(body.total_count).toBe(2);
    // The default id ASC order spans BOTH repos (the admin's census).
    expect(body.jobs.map((j) => j.id)).toEqual([claimed.jobIds[0], other.jobIds[0]]);

    const apiA = `https://example.com/api/v1/repos/alice/${repoA.slug}`;
    const htmlA = `https://example.com/alice/${repoA.slug}`;
    expect(body.jobs[0]).toEqual({
      id: claimed.jobIds[0],
      url: `${apiA}/actions/jobs/${claimed.jobIds[0]}`,
      html_url: `${htmlA}/actions/runs/${claimed.run.id}/jobs/${claimed.jobIds[0]}`,
      run_id: claimed.run.id,
      run_url: `${apiA}/actions/runs/${claimed.run.id}`,
      name: "build",
      labels: ["ubuntu-latest", "docker"],
      run_attempt: 1,
      head_sha: sha40(0xf001),
      head_branch: "main",
      status: "in_progress",
      runner_id: claimingRunner.id,
      runner_name: "claiming-runner",
      steps: [
        { name: "checkout", number: 0, status: "completed", conclusion: "success", started_at: started.toISOString(), completed_at: stopped.toISOString() },
        { name: "build", number: 1, status: "in_progress", started_at: stopped.toISOString(), completed_at: GO_ZERO },
      ],
      // The job row's created is the insertion seam's shared `now` — the
      // run row carries the same Date, so the ISO renders equal.
      created_at: claimed.run.created.toISOString(),
      started_at: started.toISOString(),
      completed_at: GO_ZERO,
    });
  });

  it("sort/order — the default id ASC (order IGNORED without sort), desc, and the two 422 texts in upstream's arm order", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    for (const n of [1, 2, 3]) {
      await seedActionRun(repoId, alice.id, { index: n, jobs: [{ jobId: `j${n}` }] });
    }
    const ids = async (q: string): Promise<number[]> => {
      const res = await get(`/api/v1/admin/actions/jobs${q}`, admin.id);
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
    const badMode = await get("/api/v1/admin/actions/jobs?sort=bogus", admin.id);
    expect(badMode.status).toBe(422);
    expect(await messageOf(badMode)).toBe('Invalid sort mode: "bogus"');
    const badOrder = await get("/api/v1/admin/actions/jobs?sort=id&order=bogus", admin.id);
    expect(badOrder.status).toBe(422);
    expect(await messageOf(badOrder)).toBe('Invalid sort order: "bogus"');
    const both = await get("/api/v1/admin/actions/jobs?sort=bogus&order=bogus", admin.id);
    expect(await messageOf(both)).toBe('Invalid sort order: "bogus"');
  });

  it("the status filter and the invalid-status 400; pagination rides page/limit", async () => {
    const { alice, admin } = await seedWorld();
    const { repoId } = await seedRepo(alice);
    await seedActionRun(repoId, alice.id, {
      index: 1,
      runStatus: ACTION_STATUS_FAILURE,
      jobs: [{ jobId: "build", status: ACTION_STATUS_FAILURE }],
    });
    await seedActionRun(repoId, alice.id, { index: 2 });

    const failed = await get("/api/v1/admin/actions/jobs?status=failure", admin.id);
    expect(failed.status).toBe(200);
    const failedBody = await jsonBody<WorkflowJobsEnvelope>(failed);
    expect(failedBody.total_count).toBe(1);
    expect(failedBody.jobs[0]).toMatchObject({ status: "completed", conclusion: "failure" });

    expect((await get("/api/v1/admin/actions/jobs?limit=1&page=2", admin.id)).headers.get("x-total-count")).toBe("2");

    const bad = await get("/api/v1/admin/actions/jobs?status=bogus", admin.id);
    expect(bad.status).toBe(400);
    expect(await messageOf(bad)).toBe("invalid status bogus");
  });
});
