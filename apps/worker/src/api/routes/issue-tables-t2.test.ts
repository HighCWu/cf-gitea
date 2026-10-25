/**
 * Tier-2 issue TABLE-family routes (routes/issue-tables-t2.ts) on real D1:
 * the issue assignees trio, the dependency/blocks family, the stopwatch trio
 * and the tracked-times quartet, plus the repoNewPinAllowed probe — the
 * operations riding migration 0012's four tables (`issue_assignees`,
 * `issue_dependency`, `tracked_time`, `stopwatch`).
 *
 * Standalone mount per family (the issue-write-t2.test.ts convention): the
 * register function takes requireAuth + optionalAuth, the stub resolver maps
 * the owner token to the seeded user id 1 (the repo owner) and the neighbor
 * token to a non-writer row, so the writer gates are exercisable without
 * collaborator rows.
 *
 * Upstream behavior pins mirrored by these assertions are cited in the
 * route-module header (issue_assignee.go / issue_dependency.go /
 * issue_stopwatch.go / issue_tracked_time.go).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import {
  comments,
  issueAssignees,
  issueDependencies,
  issuePins,
  issueStopwatches,
  issues,
  repositories,
  trackedTimes,
  users,
  webhookDeliveries,
  webhooks,
} from "../../db/schema";
import {
  STUB_USER,
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerIssueTablesT2Routes } from "./issue-tables-t2";
import { IssuesService } from "../../issues/service";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";

const TOKEN = "stub-token"; // resolves to STUB_USER (id 1) — the repo owner
const TOKEN_NEIGHBOR = "neighbor-token"; // resolves to the non-writer neighbor
const NOW = new Date("2026-02-03T04:05:06Z");
const REPO_ID = "8400";
const OTHER_REPO_ID = "8401";
const VAULT_REPO_ID = "8402"; // private, owner 1 — the assignability-403 arm
const HIDDEN_REPO_ID = "8403"; // recluse's private repo — the invisible-foreign 404

/** The owner's site-admin flag (the resolver seam — STUB_USER is frozen). */
let ownerIsAdmin = false;
/** Neighbor / org / outsider ids (assigned per seed). */
let neighborId = 0;
let orgId = 0;
let recluseId = 0;

/** Issue handles (re-seeded per test). */
let issueA = { id: 0, index: 0 };
let issueB = { id: 0, index: 0 };
let issueC = { id: 0, index: 0 }; // lives in the second repo
let issueV = { id: 0, index: 0 }; // lives in the private vault repo

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return Promise.resolve({ ...STUB_USER, is_admin: ownerIsAdmin });
      if (token === TOKEN_NEIGHBOR) {
        return Promise.resolve({
          id: neighborId,
          login: "neighbor",
          email: "",
          full_name: "Neighbor",
          avatar_url: "",
          html_url: "",
          language: "en-US",
          location: "",
          website: "",
          description: "",
          active: true,
          is_admin: false,
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
        });
      }
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const jsonBody = (body: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const send = familyApp((app) =>
  registerIssueTablesT2Routes(app, createTokenAuthMiddleware(resolver()), createOptionalTokenAuthMiddleware(resolver())),
);

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

/** Fresh rows per test: owner + neighbor + org + outsider, four repos, four issues. */
beforeEach(async () => {
  ownerIsAdmin = false;
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "issue_assignees",
    "issue_dependency",
    "tracked_time",
    "stopwatch",
    "comments",
    "issue_labels",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_topics",
    "repo_watchers",
    "repo_collaborators",
    "stars",
    "follows",
    "repo_counters",
    "commit_statuses",
    "repo_units",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const seedUser = async (username: string, type: "user" | "org" = "user") => {
    const row = await drizzle(env.DB)
      .insert(users)
      .values({ username, usernameLower: username, status: "active", type, createdAt: NOW })
      .returning({ id: users.id })
      .then((rows) => rows[0]!);
    return row.id;
  };
  neighborId = await seedUser("neighbor");
  orgId = await seedUser("org-team", "org");
  recluseId = await seedUser("recluse");

  const seedRepo = (id: string, slug: string, ownerId: number, visibility: "public" | "private") =>
    drizzle(env.DB).insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: ownerId === 1 ? "cf-gitea-stub" : "recluse",
      ownerId,
      slug,
      visibility,
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
    });
  await seedRepo(REPO_ID, "writes", 1, "public");
  await seedRepo(OTHER_REPO_ID, "other", 1, "public");
  await seedRepo(VAULT_REPO_ID, "vault", 1, "private");
  await seedRepo(HIDDEN_REPO_ID, "hidden", recluseId, "private");

  const service = new IssuesService(env.DB);
  const a = await service.createIssue({ repoId: REPO_ID, title: "alpha", content: "first", posterId: 1 });
  const b = await service.createIssue({ repoId: REPO_ID, title: "beta", content: "second", posterId: 1 });
  const c = await service.createIssue({ repoId: OTHER_REPO_ID, title: "gamma", content: "third", posterId: 1 });
  const v = await service.createIssue({ repoId: VAULT_REPO_ID, title: "vaulted", posterId: 1 });
  issueA = { id: a.id, index: a.index };
  issueB = { id: b.id, index: b.index };
  issueC = { id: c.id, index: c.index };
  issueV = { id: v.id, index: v.index };
});

/** The system comments of one issue (optionally by type), id order. */
function systemComments(issueId: number, type?: number) {
  const conditions =
    type === undefined ? [eq(comments.issueId, issueId)] : [eq(comments.issueId, issueId), eq(comments.type, type)];
  return drizzle(env.DB)
    .select()
    .from(comments)
    .where(and(...conditions))
    .orderBy(asc(comments.id))
    .all();
}

/** The issue row (the num_comments probe). */
function issueRow(issueId: number) {
  return drizzle(env.DB)
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0]!);
}

/** Active webhook subscribed to the given events — the fan-out matcher target. */
async function seedHook(repoId: string, events: string[]): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/assignee-test",
      events: JSON.stringify({ choose_events: true, branch_filter: "*", events: Object.fromEntries(events.map((e) => [e, true])) }),
      isActive: true,
      type: "gitea",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: webhooks.id })
    .then((rows) => rows[0]!);
  return rows.id;
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

async function deliveriesFor(hookId: number): Promise<DeliveryRow[]> {
  return drizzle(env.DB)
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.hookId, hookId))
    .all();
}

// ---------------------------------------------------------------------------
// assignees
// ---------------------------------------------------------------------------

describe("POST/DELETE /repos/{owner}/{repo}/issues/{index}/assignees (issueAddAssignees/issueRemoveAssignees)", () => {
  it("adds assignees (201): the guarded edge row, one type-9 comment, the counter fold, the enriched wire", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["neighbor"] })));
    expect(res.status).toBe(201);
    const wire = (await res.json<Record<string, unknown>>()) as {
      assignee: { login: string } | null;
      assignees: Array<{ login: string }> | null;
    };
    expect(wire.assignee?.login).toBe("neighbor"); // the first assignee duplicated
    expect(wire.assignees?.map((u) => u.login)).toEqual(["neighbor"]);

    const edges = await drizzle(env.DB).select().from(issueAssignees).all();
    expect(edges).toEqual([{ id: edges[0]!.id, issueId: issueA.id, assigneeId: neighborId }]);

    const type9 = await systemComments(issueA.id, 9);
    expect(type9).toHaveLength(1);
    expect(type9[0]).toMatchObject({ posterId: 1, assigneeId: neighborId, removedAssignee: 0, content: "" });
    expect((await issueRow(issueA.id)).numComments).toBe(1);
  });

  it("skips already-assigned users silently (no duplicate edge, no extra comment)", async () => {
    expect(
      (await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["neighbor"] })))).status,
    ).toBe(201);
    expect(
      (await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["neighbor"] })))).status,
    ).toBe(201);
    expect(await drizzle(env.DB).select().from(issueAssignees).all()).toHaveLength(1);
    expect(await systemComments(issueA.id, 9)).toHaveLength(1);
  });

  it("resolves the whole name list before any write — the 422 unknown-user arm aborts cleanly", async () => {
    const res = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`,
      authed(jsonBody({ assignees: ["neighbor", "ghost"] })),
    );
    expect(res.status).toBe(422);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("user does not exist [uid: 0, name: ghost]");
    expect(await drizzle(env.DB).select().from(issueAssignees).all()).toHaveLength(0);
    expect(await systemComments(issueA.id)).toHaveLength(0);
  });

  it("refuses an org assignee with the upstream 400 and a non-assignable user with the 403 access error", async () => {
    const orgRes = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["org-team"] })));
    expect(orgRes.status).toBe(400);
    expect(((await orgRes.json<Record<string, unknown>>())).message).toBe(
      `organization can't be added as assignee [user_id: ${orgId}, repo_id: ${Number(REPO_ID)}]`,
    );
    expect(await drizzle(env.DB).select().from(issueAssignees).all()).toHaveLength(0);

    // A private repo grants assignability to no one but its owner/admins/collaborators.
    const vaultRes = await send(`/repos/cf-gitea-stub/vault/issues/${issueV.index}/assignees`, authed(jsonBody({ assignees: ["recluse"] })));
    expect(vaultRes.status).toBe(403);
    expect(((await vaultRes.json<Record<string, unknown>>())).message).toBe(
      `user doesn't have access to repo [user_id: ${recluseId}, repo_name: vault]`,
    );
    expect(await drizzle(env.DB).select().from(issueAssignees).all()).toHaveLength(0);
  });

  it("removes assignees (200): the edge delete, the type-9 removal comment, unassigned users skipped", async () => {
    expect(
      (await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["neighbor"] })))).status,
    ).toBe(201);

    const res = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`,
      authed(jsonBody({ assignees: ["neighbor"] }, "DELETE")),
    );
    expect(res.status).toBe(200);
    const wire = (await res.json<Record<string, unknown>>()) as { assignees: Array<unknown> | null };
    expect(wire.assignees).toBeNull();

    expect(await drizzle(env.DB).select().from(issueAssignees).all()).toHaveLength(0);
    const type9 = await systemComments(issueA.id, 9);
    expect(type9).toHaveLength(2); // the add + the remove
    expect(type9[1]).toMatchObject({ assigneeId: neighborId, removedAssignee: 1 });
    expect((await issueRow(issueA.id)).numComments).toBe(2);

    // Removing an unassigned user is the silent skip (no third comment).
    expect(
      (await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["neighbor"] }, "DELETE")))).status,
    ).toBe(200);
    expect(await systemComments(issueA.id, 9)).toHaveLength(2);
  });

  it("gates writes on writers (bare 403) and archived repos (423); 401/404 per the shared guards", async () => {
    const path = `/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`;
    expect((await send(path, { method: "POST" })).status).toBe(401);
    const neighborRes = await send(path, authed(jsonBody({ assignees: ["neighbor"] }), TOKEN_NEIGHBOR));
    expect(neighborRes.status).toBe(403);
    expect(((await neighborRes.json<Record<string, unknown>>())).message).toBe(""); // the bare ctx.Status(403)

    expect((await send("/repos/cf-gitea-stub/ghost/issues/1/assignees", authed(jsonBody({ assignees: [] })))).status).toBe(404);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/999/assignees`, authed(jsonBody({ assignees: [] })))).status).toBe(404);

    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, REPO_ID));
    const archived = await send(path, authed(jsonBody({ assignees: ["neighbor"] })));
    expect(archived.status).toBe(423);
    expect(((await archived.json<Record<string, unknown>>())).message).toBe("repo is archived");
  });

  it("answers the assignability probe (issueCheckAssignee): 204 assignable, 400 org, 404 unknown, 403 non-assignable", async () => {
    // Anonymous per upstream registration; a public repo makes everyone assignable.
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees/neighbor`)).status).toBe(204);

    const org = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees/org-team`);
    expect(org.status).toBe(400);
    expect(((await org.json<Record<string, unknown>>())).message).toBe(
      `organization can't be added as assignee [user_id: ${orgId}, repo_id: ${Number(REPO_ID)}]`,
    );

    const unknown = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees/ghost`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json<Record<string, unknown>>())).message).toBe("user does not exist [uid: 0, name: ghost]");

    // The private repo is invisible to an anonymous probe — the owner's
    // token sees it, and the neighbor is simply not assignable there.
    const vault = await send(`/repos/cf-gitea-stub/vault/issues/${issueV.index}/assignees/neighbor`, authed());
    expect(vault.status).toBe(403);
    expect(((await vault.json<Record<string, unknown>>())).message).toBe(
      `user doesn't have access to repo [user_id: ${neighborId}, repo_name: vault]`,
    );
  });
});

// ---------------------------------------------------------------------------
// issue_assign / pull_request_assign webhook emissions (upstream
// services/webhook/notifier.go IssueChangeAssignee:161-202 — ONE event per
// actually-changed assignee, action assigned/unassigned, the one-element
// changes.added_assignees / removed_assignees block; the `issue.IsPull`
// discriminant picks the event type).
// ---------------------------------------------------------------------------

describe("assignee webhook emissions (issueAddAssignees / issueRemoveAssignees)", () => {
  it("emits one issue_assign assigned event per added assignee with changes.added_assignees", async () => {
    const hookId = await seedHook(REPO_ID, ["issue_assign"]);

    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`, authed(jsonBody({ assignees: ["neighbor", "recluse"] })));
    expect(res.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_assign", "issue_assign"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["assigned", "assigned"]);
    const first = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 IssuePayload (hook.go:435) + the ChangesPayload assignee side.
    expect(Object.keys(first).sort()).toEqual(["action", "changes", "commit_id", "issue", "number", "repository", "sender"]);
    expect(first.number).toBe(issueA.index);
    // The changed side only (ChangesPayload.assignees lists are omitempty)
    // with the one assignee rendered as the §2.7 User object.
    expect(Object.keys(first.changes as object).sort()).toEqual(["added_assignees"]);
    const firstChanges = first.changes as { added_assignees: Array<Record<string, unknown>> };
    expect(firstChanges.added_assignees).toHaveLength(1);
    expect(firstChanges.added_assignees[0]).toMatchObject({ login: "neighbor" });
    expect(first.commit_id).toBe("");
    expect(first.sender).toMatchObject({ login: "cf-gitea-stub" });
    expect(first.repository).toMatchObject({ full_name: "cf-gitea-stub/writes" });
    // The payload issue renders the POST-change assignee set (upstream
    // ToAPIIssue LoadAssignees) through the module's enriched wire.
    const second = JSON.parse(deliveries[1]!.payloadContent) as {
      changes: { added_assignees: Array<{ login: string }> };
      issue: { assignees: Array<{ login: string }> | null };
    };
    expect(second.changes.added_assignees.map((u) => u.login)).toEqual(["recluse"]);
    expect(second.issue.assignees?.map((u) => u.login)).toEqual(["neighbor", "recluse"]);
  });

  it("emits unassigned with changes.removed_assignees on DELETE and the emptied issue assignee set", async () => {
    const hookId = await seedHook(REPO_ID, ["issue_assign"]);
    const path = `/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`;
    expect((await send(path, authed(jsonBody({ assignees: ["neighbor"] })))).status).toBe(201);

    expect((await send(path, authed(jsonBody({ assignees: ["neighbor"] }, "DELETE")))).status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_assign", "issue_assign"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["assigned", "unassigned"]);
    const removed = JSON.parse(deliveries[1]!.payloadContent) as {
      changes: { removed_assignees: Array<Record<string, unknown>> };
      issue: { assignees: Array<unknown> | null };
    };
    expect(Object.keys(removed.changes as object).sort()).toEqual(["removed_assignees"]);
    expect(removed.changes.removed_assignees).toHaveLength(1);
    expect(removed.changes.removed_assignees[0]).toMatchObject({ login: "neighbor" });
    expect(removed.issue.assignees).toBeNull();
  });

  it("stays silent for no-op assign/unassign writes, push-only hooks, and sibling subscriptions", async () => {
    const hookId = await seedHook(REPO_ID, ["issue_assign"]);
    const pushHook = await seedHook(REPO_ID, ["push"]); // push-only-style selection
    const issuesHook = await seedHook(REPO_ID, ["issues"]);
    const path = `/repos/cf-gitea-stub/writes/issues/${issueA.index}/assignees`;

    expect((await send(path, authed(jsonBody({ assignees: ["neighbor"] })))).status).toBe(201);
    expect(await deliveriesFor(hookId)).toHaveLength(1);

    // Already-assigned → AddAssigneeIfNotAssigned skips, no notification.
    expect((await send(path, authed(jsonBody({ assignees: ["neighbor"] })))).status).toBe(201);
    // Not-assigned removal → the silent skip, no notification.
    expect((await send(path, authed(jsonBody({ assignees: ["recluse"] }, "DELETE")))).status).toBe(200);
    expect(await deliveriesFor(hookId)).toHaveLength(1);
    expect(await deliveriesFor(pushHook)).toHaveLength(0);
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(webhookDeliveries).all()).toHaveLength(1);
  });

  it("routes PR assignee writes to pull_request_assign with the PullRequestPayload field set", async () => {
    const service = new IssuesService(env.DB);
    const pull = await service.createPullRequest({
      repoId: REPO_ID,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR assignees",
      posterId: 1,
    });
    const hookId = await seedHook(REPO_ID, ["pull_request_assign"]);
    const issuesHook = await seedHook(REPO_ID, ["issue_assign"]);

    const res = await send(`/repos/cf-gitea-stub/writes/issues/${pull.issue.index}/assignees`, authed(jsonBody({ assignees: ["neighbor"] })));
    expect(res.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_assign");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 PullRequestPayload (hook.go:484) + the ChangesPayload assignee
    // side — the landed pulls.ts emission field set.
    expect(Object.keys(payload).sort()).toEqual(["action", "changes", "commit_id", "number", "pull_request", "repository", "sender"]);
    expect(payload.action).toBe("assigned");
    expect(payload.number).toBe(pull.issue.index);
    expect((payload.changes as { added_assignees: Array<{ login: string }> }).added_assignees.map((u) => u.login)).toEqual(["neighbor"]);
    expect((payload.pull_request as Record<string, unknown>).title).toBe("PR assignees");
    // A pull_request_assign-subscribed hook never sees issue_assign traffic.
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(webhookDeliveries).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// dependencies + blocks
// ---------------------------------------------------------------------------

describe("GET/POST/DELETE /repos/{owner}/{repo}/issues/{index}/dependencies (issueListIssueDependencies/…)", () => {
  /** Fresh per test — the seeded indexes only exist after beforeEach. */
  const depOnB = () => ({ index: issueB.index, owner: "cf-gitea-stub", repo: "writes" });

  it("creates the edge (201): the row, the paired type-19 comments, both counter folds", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB())));
    expect(res.status).toBe(201);
    expect(((await res.json<Record<string, unknown>>())).number).toBe(issueA.index); // the path issue's wire

    const edges = await drizzle(env.DB).select().from(issueDependencies).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ userId: 1, issueId: issueA.id, dependencyId: issueB.id });
    expect(edges[0]!.createdAt).toBeInstanceOf(Date);

    const onA = await systemComments(issueA.id, 19);
    const onB = await systemComments(issueB.id, 19);
    expect(onA).toHaveLength(1);
    expect(onA[0]).toMatchObject({ posterId: 1, dependentIssueId: issueB.id });
    expect(onB).toHaveLength(1);
    expect(onB[0]).toMatchObject({ posterId: 1, dependentIssueId: issueA.id });
    expect((await issueRow(issueA.id)).numComments).toBe(1);
    expect((await issueRow(issueB.id)).numComments).toBe(1);
  });

  it("cross-repo form issues resolve through the visibility matrix; invisible ones redact to 404", async () => {
    const res = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`,
      authed(jsonBody({ index: issueC.index, owner: "cf-gitea-stub", repo: "other" })),
    );
    expect(res.status).toBe(201);
    expect(await drizzle(env.DB).select().from(issueDependencies).all()).toHaveLength(1);

    const invisible = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`,
      authed(jsonBody({ index: 1, owner: "recluse", repo: "hidden" })),
    );
    expect(invisible.status).toBe(404); // the APIErrorNotFound redaction
    expect(((await invisible.json<Record<string, unknown>>())).message).toBe("not found");
  });

  it("500s the duplicate edge and the circular pair with the upstream model-error texts", async () => {
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB())))).status).toBe(201);

    const dup = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB())));
    expect(dup.status).toBe(500);
    expect(((await dup.json<Record<string, unknown>>())).message).toBe(
      `issue dependency does already exist [issue id: ${issueA.id}, dependency id: ${issueB.id}]`,
    );

    const circular = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueB.index}/dependencies`,
      authed(jsonBody({ index: issueA.index, owner: "cf-gitea-stub", repo: "writes" })),
    );
    expect(circular.status).toBe(500);
    expect(((await circular.json<Record<string, unknown>>())).message).toBe(
      "circular dependencies exists (two issues blocking each other) " + `[issue id: ${issueB.id}, dependency id: ${issueA.id}]`,
    );
  });

  it("lists the blockers (200) with the counted pagination headers", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB())));
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const list = (await res.json<Array<Record<string, unknown>>>()) as Array<{ number: number }>;
    expect(list.map((issue) => issue.number)).toEqual([issueB.index]);
  });

  it("removes the edge (200) with the paired type-20 comments; a missing edge is the upstream 500", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB())));

    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB(), "DELETE")));
    expect(res.status).toBe(200);
    expect(((await res.json<Record<string, unknown>>())).number).toBe(issueA.index);
    expect(await drizzle(env.DB).select().from(issueDependencies).all()).toHaveLength(0);
    expect(await systemComments(issueA.id, 20)).toHaveLength(1);
    expect(await systemComments(issueB.id, 20)).toHaveLength(1);
    expect((await issueRow(issueA.id)).numComments).toBe(2); // the 19 + the 20
    expect((await issueRow(issueB.id)).numComments).toBe(2);

    const missing = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB(), "DELETE")));
    expect(missing.status).toBe(500);
    expect(((await missing.json<Record<string, unknown>>())).message).toBe(
      `issue dependency does not exist [issue id: ${issueA.id}, dependency id: ${issueB.id}]`,
    );
  });

  it("hides existence behind 404 for non-writers and answers 423 on an archived repo", async () => {
    const neighborRes = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`,
      authed(jsonBody(depOnB()), TOKEN_NEIGHBOR),
    );
    expect(neighborRes.status).toBe(404);
    expect(((await neighborRes.json<Record<string, unknown>>())).message).toBe("not found");

    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, REPO_ID));
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/dependencies`, authed(jsonBody(depOnB())))).status).toBe(423);
  });
});

describe("GET/POST/DELETE /repos/{owner}/{repo}/issues/{index}/blocks (issueListBlocks/…)", () => {
  /** Fresh per test — the seeded indexes only exist after beforeEach. */
  const formB = () => ({ index: issueB.index, owner: "cf-gitea-stub", repo: "writes" });

  it("blocks (201): the edge is (form issue depends on path issue); 201 echoes the PATH issue's wire", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`, authed(jsonBody(formB())));
    expect(res.status).toBe(201);
    expect(((await res.json<Record<string, unknown>>())).number).toBe(issueA.index);

    const edges = await drizzle(env.DB).select().from(issueDependencies).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ userId: 1, issueId: issueB.id, dependencyId: issueA.id });
    expect(edges[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("lists the blocked issues (200) with NO pagination headers (upstream paginates in memory)", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`, authed(jsonBody(formB())));
    // A cross-repo dependent appears too (the visibility matrix resolves it).
    await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`,
      authed(jsonBody({ index: issueC.index, owner: "cf-gitea-stub", repo: "other" })),
    );

    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBeNull();
    const list = (await res.json<Array<Record<string, unknown>>>()) as Array<{ number: number }>;
    expect(list.map((issue) => issue.number)).toEqual([issueB.index, issueC.index]); // the home repo first

    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks?page=1&limit=1`)).headers.get("X-Total-Count")).toBeNull();
  });

  it("detaches via DELETE blocks (200); the missing-edge arm is the shared 500", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`, authed(jsonBody(formB())));
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`, authed(jsonBody(formB(), "DELETE")));
    expect(res.status).toBe(200);
    expect(((await res.json<Record<string, unknown>>())).number).toBe(issueA.index);
    expect(await drizzle(env.DB).select().from(issueDependencies).all()).toHaveLength(0);

    const missing = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`, authed(jsonBody(formB(), "DELETE")));
    expect(missing.status).toBe(500);
    expect(((await missing.json<Record<string, unknown>>())).message).toBe(
      `issue dependency does not exist [issue id: ${issueB.id}, dependency id: ${issueA.id}]`,
    );
  });

  it("hides existence behind 404 for non-writers; the archived gate stays LIVE only for foreign targets", async () => {
    const neighborRes = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`, authed(jsonBody(formB()), TOKEN_NEIGHBOR));
    expect(neighborRes.status).toBe(404);

    // The blocks pair carries no mustNotBeArchived upstream: the gate is the
    // target-side check, so a blocked issue in a live repo still works while
    // the path repo is archived.
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, REPO_ID));
    const cross = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/blocks`,
      authed(jsonBody({ index: issueC.index, owner: "cf-gitea-stub", repo: "other" })),
    );
    expect(cross.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// stopwatch
// ---------------------------------------------------------------------------

describe("POST/DELETE /repos/{owner}/{repo}/issues/{index}/stopwatch/* (issueStartStopWatch/…)", () => {
  it("starts (201): the stopwatch row, the start_tracking (12) comment, the fold", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/start`, authed({ method: "POST" }));
    expect(res.status).toBe(201);

    const rows = await drizzle(env.DB).select().from(issueStopwatches).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issueId: issueA.id, userId: 1 });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(await systemComments(issueA.id, 12)).toHaveLength(1);
    expect((await issueRow(issueA.id)).numComments).toBe(1);
  });

  it("409s a re-start on the same issue; a start on another issue FINISHES the first (time banked, stop comment)", async () => {
    // A stopwatch started 65 minutes ago (seeded) — stopping banks ≥ 3900 s.
    await drizzle(env.DB).insert(issueStopwatches).values({ issueId: issueA.id, userId: 1, createdAt: new Date(Date.now() - 3900 * 1000) });

    const again = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/start`, authed({ method: "POST" }));
    expect(again.status).toBe(409);
    expect(((await again.json<Record<string, unknown>>())).message).toBe("cannot start a stopwatch again if it already exists");

    const moved = await send(`/repos/cf-gitea-stub/writes/issues/${issueB.index}/stopwatch/start`, authed({ method: "POST" }));
    expect(moved.status).toBe(201);

    const banked = await drizzle(env.DB).select().from(trackedTimes).all();
    expect(banked).toHaveLength(1);
    expect(banked[0]).toMatchObject({ issueId: issueA.id, userId: 1, deleted: false });
    expect(banked[0]!.seconds).toBeGreaterThanOrEqual(3900);
    const stops = await systemComments(issueA.id, 13);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.content).toMatch(/^1 hour 5 minutes/); // SecToHours(≥ 3900)

    const running = await drizzle(env.DB).select().from(issueStopwatches).all();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ issueId: issueB.id, userId: 1 });
    expect(running[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("stops (201): the elapsed tracked time, the stop_tracking (13) comment, the row delete", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/start`, authed({ method: "POST" }));
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/stop`, authed({ method: "POST" }));
    expect(res.status).toBe(201);
    expect(await drizzle(env.DB).select().from(issueStopwatches).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(trackedTimes).all()).toHaveLength(1);
    expect(await systemComments(issueA.id, 13)).toHaveLength(1);
  });

  it("409s stopping a non-existent stopwatch", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/stop`, authed({ method: "POST" }));
    expect(res.status).toBe(409);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("cannot stop a non-existent stopwatch");
  });

  it("cancels (204): the row delete WITHOUT banking time and the cancel_tracking (15) comment", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/start`, authed({ method: "POST" }));
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/delete`, authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(issueStopwatches).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(trackedTimes).all()).toHaveLength(0);
    expect(await systemComments(issueA.id, 15)).toHaveLength(1);
  });

  it("409s cancelling a non-existent stopwatch; gates on writers with the bare 403", async () => {
    const cancel = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/delete`, authed({ method: "DELETE" }));
    expect(cancel.status).toBe(409);
    expect(((await cancel.json<Record<string, unknown>>())).message).toBe("cannot cancel a non-existent stopwatch");

    const neighborRes = await send(
      `/repos/cf-gitea-stub/writes/issues/${issueA.index}/stopwatch/start`,
      authed({ method: "POST" }, TOKEN_NEIGHBOR),
    );
    expect(neighborRes.status).toBe(403);
    expect(((await neighborRes.json<Record<string, unknown>>())).message).toBe("");
  });
});

// ---------------------------------------------------------------------------
// tracked times
// ---------------------------------------------------------------------------

describe("GET/POST/DELETE /repos/{owner}/{repo}/issues/{index}/times (issueTrackedTimes/…)", () => {
  /** One owner entry (90 s) + one neighbor entry (30 s, added via the
   *  user_name override and a fixed created) on issue A. */
  async function seedTwoEntries(): Promise<void> {
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 90 })))).status).toBe(200);
    expect(
      (
        await send(
          `/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`,
          authed(jsonBody({ time: 30, user_name: "neighbor", created: "2026-01-01T00:00:00Z" })),
        )
      ).status,
    ).toBe(200);
  }

  it("adds time (200): the entry, the add_time_manual (14) `|<seconds>` comment, the fold, the wire", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 90 })));
    expect(res.status).toBe(200);
    const wire = (await res.json<Record<string, unknown>>());
    expect(wire).toMatchObject({ time: 90, user_id: 1, user_name: "cf-gitea-stub", issue_id: issueA.id });
    expect(wire.id).toBeTypeOf("number");

    const rows = await drizzle(env.DB).select().from(trackedTimes).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issueId: issueA.id, userId: 1, seconds: 90, deleted: false });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    const type14 = await systemComments(issueA.id, 14);
    expect(type14).toHaveLength(1);
    expect(type14[0]).toMatchObject({ posterId: 1, content: "|90" });
    expect((await issueRow(issueA.id)).numComments).toBe(1);
  });

  it("adds time for another user via the repo-admin override; an unknown override user is the 404", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 30, user_name: "neighbor" })));
    expect(res.status).toBe(200);
    const wire = (await res.json<Record<string, unknown>>());
    expect(wire.user_id).toBe(neighborId);
    expect(wire.user_name).toBe("neighbor");
    expect((await drizzle(env.DB).select().from(trackedTimes).all())[0]!.userId).toBe(neighborId);

    const unknown = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 30, user_name: "ghost" })));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json<Record<string, unknown>>())).message).toBe("user does not exist [uid: 0, name: ghost]");
  });

  it("gates time writes on writers (the bare 403)", async () => {
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 5 }), TOKEN_NEIGHBOR));
    expect(res.status).toBe(403);
    expect(((await res.json<Record<string, unknown>>())).message).toBe("");
    expect(await drizzle(env.DB).select().from(trackedTimes).all()).toHaveLength(0);
  });

  it("lists times (200) with the embedded issue, the user/since filters and deleted entries hidden", async () => {
    await seedTwoEntries();
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const list = (await res.json<Array<Record<string, unknown>>>());
    expect(list.map((row) => row.user_name)).toEqual(["cf-gitea-stub", "neighbor"]); // id order
    expect((list[0]!.issue as Record<string, unknown>).number).toBe(issueA.index); // the embedded issue

    // The user filter (a writer may filter by anyone).
    const filtered = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times?user=neighbor`, authed());
    const rows = (await filtered.json<Array<Record<string, unknown>>>());
    expect(rows.map((row) => row.user_name)).toEqual(["neighbor"]);

    // The since filter drops the 2026-01-01 neighbor entry.
    const since = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times?since=2026-02-01T00:00:00Z`, authed());
    const sinceRows = (await since.json<Array<Record<string, unknown>>>());
    expect(sinceRows.map((row) => row.user_name)).toEqual(["cf-gitea-stub"]);

    // An unknown filter user is the 404.
    const ghost = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times?user=ghost`, authed());
    expect(ghost.status).toBe(404);
    expect(((await ghost.json<Record<string, unknown>>())).message).toBe("user does not exist [uid: 0, name: ghost]");
  });

  it("collapses the user filter for non-writers (cantSetUser): scoped to own rows, 403 for another user", async () => {
    await seedTwoEntries();
    const own = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(undefined, TOKEN_NEIGHBOR));
    expect(own.status).toBe(200);
    const rows = (await own.json<Array<Record<string, unknown>>>());
    expect(rows.map((row) => row.user_name)).toEqual(["neighbor"]); // scoped, not the full list

    const other = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times?user=cf-gitea-stub`, authed(undefined, TOKEN_NEIGHBOR));
    expect(other.status).toBe(403);
    expect(((await other.json<Record<string, unknown>>())).message).toBe("query by user not allowed; not enough rights");
  });

  it("resets (204): soft-deletes ONLY the doer's own entries with the `|<sum>` type-26 comment", async () => {
    await seedTwoEntries();
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed({ method: "DELETE" }));
    expect(res.status).toBe(204);

    const rows = await drizzle(env.DB).select().from(trackedTimes).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.userId === 1)?.deleted).toBe(true); // the doer's entry
    expect(rows.find((row) => row.userId === neighborId)?.deleted).toBe(false); // untouched

    const type26 = await systemComments(issueA.id, 26);
    expect(type26).toHaveLength(1);
    expect(type26[0]).toMatchObject({ posterId: 1, content: "|90" });
  });

  it("404s the reset when the doer's own sum is zero — including a lone 0-second entry", async () => {
    const empty = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed({ method: "DELETE" }));
    expect(empty.status).toBe(404);
    expect(((await empty.json<Record<string, unknown>>())).message).toBe("tracked_time does not exist");

    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 0 })));
    const zeroSum = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed({ method: "DELETE" }));
    expect(zeroSum.status).toBe(404);
    expect((await drizzle(env.DB).select().from(trackedTimes).all())[0]!.deleted).toBe(false); // nothing deleted
  });

  it("deletes one entry (204): owner-own arm, the entry-owner-posted type-26 comment, the already-deleted 404", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 90 })));
    const ownId = (await drizzle(env.DB).select().from(trackedTimes).all())[0]!.id;

    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times/${ownId}`, authed({ method: "DELETE" }))).status).toBe(204);
    expect((await drizzle(env.DB).select().from(trackedTimes).all())[0]!.deleted).toBe(true);
    expect((await systemComments(issueA.id, 26))[0]).toMatchObject({ posterId: 1, content: "|90" });

    const again = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times/${ownId}`, authed({ method: "DELETE" }));
    expect(again.status).toBe(404);
    expect(((await again.json<Record<string, unknown>>())).message).toBe("tracked time was already deleted");
  });

  it("lets a site admin delete another user's entry; the comment posts as the ENTRY'S owner", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 30, user_name: "neighbor" })));
    const entryId = (await drizzle(env.DB).select().from(trackedTimes).all())[0]!.id;

    // A plain writer (the repo owner, not a site admin) may NOT delete
    // another user's entry — the bare 403.
    const forbidden = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times/${entryId}`, authed({ method: "DELETE" }));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json<Record<string, unknown>>())).message).toBe("");

    ownerIsAdmin = true;
    const res = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times/${entryId}`, authed({ method: "DELETE" }));
    expect(res.status).toBe(204);
    expect((await drizzle(env.DB).select().from(trackedTimes).all())[0]!.deleted).toBe(true);
    expect((await systemComments(issueA.id, 26))[0]).toMatchObject({ posterId: neighborId, content: "|30" });
  });

  it("404s a missing or non-integer time id with the id-suffixed / id-less upstream texts", async () => {
    await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times`, authed(jsonBody({ time: 90 })));

    const missing = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times/999`, authed({ method: "DELETE" }));
    expect(missing.status).toBe(404);
    expect(((await missing.json<Record<string, unknown>>())).message).toBe("tracked_time does not exist [id: 999]");

    const bad = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/times/abc`, authed({ method: "DELETE" }));
    expect(bad.status).toBe(404);
    expect(((await bad.json<Record<string, unknown>>())).message).toBe("tracked_time does not exist");
  });
});

// ---------------------------------------------------------------------------
// repoNewPinAllowed
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/new_pin_allowed (repoNewPinAllowed)", () => {
  it("counts the pinned issue/pull halves against the MaxPinned cap (anonymous)", async () => {
    expect(await (await send("/repos/cf-gitea-stub/writes/new_pin_allowed")).json<Record<string, unknown>>()).toEqual({
      issues: true,
      pull_requests: true,
    });

    const service = new IssuesService(env.DB);
    for (let i = 0; i < 3; i++) {
      const issue = await service.createIssue({ repoId: REPO_ID, title: `pin-${i}`, posterId: 1 });
      await drizzle(env.DB).insert(issuePins).values({ issueId: issue.id, repoId: REPO_ID, pinOrder: i + 1 });
    }
    const pinPull = async (i: number) => {
      const pull = await service.createPullRequest({
        repoId: REPO_ID,
        headRepoId: REPO_ID,
        baseBranch: "main",
        headBranch: `topic-${i}`,
        title: `pinned pull ${i}`,
        posterId: 1,
      });
      await drizzle(env.DB).insert(issuePins).values({ issueId: pull.issue.id, repoId: REPO_ID, pinOrder: i + 1 });
    };
    await pinPull(0);

    // The issue half is full while the pull half has room:
    expect(await (await send("/repos/cf-gitea-stub/writes/new_pin_allowed")).json<Record<string, unknown>>()).toEqual({
      issues: false,
      pull_requests: true,
    });

    await pinPull(1);
    await pinPull(2);
    expect(await (await send("/repos/cf-gitea-stub/writes/new_pin_allowed")).json<Record<string, unknown>>()).toEqual({
      issues: false,
      pull_requests: false,
    });
  });

  it("404s an invisible repo", async () => {
    expect((await send("/repos/cf-gitea-stub/ghost/new_pin_allowed")).status).toBe(404);
  });
});
