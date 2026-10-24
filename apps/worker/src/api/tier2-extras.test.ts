/**
 * Tier-2 extras batch on real D1 (SPEC-0004 appendix A category a/b/d/e
 * remainder rows that ride the ALREADY-MIGRATED stores): the social listings
 * (routes/social-t2.ts — stargazers, subscribers, watched/starred repos per
 * user, the doer's following list), the topic items (routes/topic-items.ts —
 * PUT/DELETE topics/{topic}), the webhook delivery item
 * (routes/hook-delivery.ts), and the issue-family extras (routes/issue-t2.ts
 * — reactions ×2, the deprecated nested comment pair, issue subscriptions,
 * pinned issues/pulls, deadline, lock/unlock) over the issue-extras service.
 *
 * Upstream pins per family are in the route-module headers; this file drives
 * the happy paths plus each family's gate statuses against real bindings,
 * one standalone app per family (the routes ARE registered in router.ts by
 * this batch; the isolated mounts keep the families independently
 * assertable, the topics.test.ts convention).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { comments, issues, reactions, repositories, users, webhookDeliveries } from "../db/schema";
import {
  createOptionalTokenAuthMiddleware,
  createStubAuthResolver,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerIssueT2Routes } from "./routes/issue-t2";
import { registerHookDeliveryRoute } from "./routes/hook-delivery";
import { registerSocialT2Routes } from "./routes/social-t2";
import { registerTopicItemRoutes } from "./routes/topic-items";
import { IssuesService } from "../issues/service";
import { applyRepoExtrasDdl } from "./testing/repo-ddl";
import { createRepoHook } from "./services/hooks";
import { starRepo } from "./services/stars";
import { watchRepo } from "./services/repo-watchers";
import { followUser } from "./services/follows";
import { addOrUpdateCollaborator } from "./services/repo-collaborators";
import { replaceRepoTopics } from "./services/repo-topics";

const TOKEN = "stub-token"; // resolves to STUB_USER (id 1) — the repo owner
const TOKEN_NEIGHBOR = "neighbor-token"; // resolves to the non-writer neighbor
const NOW = new Date("2026-02-03T04:05:06Z");
const REPO_ID = "7100";

/** Neighbor's minimal User projection (the resolver seam). */
let neighborId = 0;

/** Issue/comment handles (re-seeded per test). */
let issueA = { id: 0, index: 0 };
let issueB = { id: 0, index: 0 };
let commentA = 0;
let pullIndex = 0;

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
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

const jsonAuthed = (body: unknown, method: string, token = TOKEN): RequestInit =>
  authed({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, token);

const socialSend = familyApp((app) => registerSocialT2Routes(app, createTokenAuthMiddleware(resolver()), createOptionalTokenAuthMiddleware(resolver())));
const topicSend = familyApp((app) => registerTopicItemRoutes(app, createTokenAuthMiddleware(resolver())));
const deliverySend = familyApp((app) => registerHookDeliveryRoute(app, createTokenAuthMiddleware(resolver())));
const issueT2Send = familyApp((app) => registerIssueT2Routes(app, createTokenAuthMiddleware(resolver()), createOptionalTokenAuthMiddleware(resolver())));

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

/** Fresh rows per test: owner + neighbor, one public repo, two issues with
 *  one comment on the first, one pull, one hook with a delivered row. */
beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "comments",
    "issue_labels",
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
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const neighbor = await drizzle(env.DB)
    .insert(users)
    .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
    .returning({ id: users.id })
    .all();
  neighborId = neighbor[0]!.id;

  await drizzle(env.DB).insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "extras",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: NOW,
  });

  const service = new IssuesService(env.DB);
  const a = await service.createIssue({ repoId: REPO_ID, title: "alpha", content: "first", posterId: 1 });
  const b = await service.createIssue({ repoId: REPO_ID, title: "beta", content: "second", posterId: 1 });
  const comment = await service.addComment({ issueId: a.id, posterId: neighborId, content: "seeded comment" });
  const pull = await service.createPullRequest({
    repoId: REPO_ID,
    headRepoId: REPO_ID,
    baseBranch: "main",
    headBranch: "topic",
    title: "seed pull",
    posterId: 1,
  });
  issueA = { id: a.id, index: a.index };
  issueB = { id: b.id, index: b.index };
  commentA = comment.id;
  pullIndex = pull.pullRequest.index;
});

/** The repositories table import is deferred to a helper so the wipe loop
 *  above stays a plain string list. */
function repositoriesTable() {
  return repositories;
}

// ---------------------------------------------------------------------------
// Social listings
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/stargazers + /subscribers (social-t2)", () => {
  it("lists starrers and watchers as users with pagination headers; 404 on missing repos", async () => {
    await starRepo(env.DB, 1, REPO_ID, NOW);
    await starRepo(env.DB, neighborId, REPO_ID, NOW);
    await watchRepo(env.DB, REPO_ID, neighborId, NOW);

    const stargazers = await socialSend(`/repos/cf-gitea-stub/extras/stargazers?limit=1`);
    expect(stargazers.status).toBe(200);
    expect(stargazers.headers.get("X-Total-Count")).toBe("2");
    const stars: Array<Record<string, unknown>> = await stargazers.json();
    expect(stars).toHaveLength(1);
    expect(String(stars[0]?.login)).toBe("cf-gitea-stub"); // users.id order

    const subscribers = await socialSend("/repos/cf-gitea-stub/extras/subscribers");
    expect(subscribers.status).toBe(200);
    const watchers: Array<Record<string, unknown>> = await subscribers.json();
    expect(watchers.map((entry) => entry.login)).toEqual(["neighbor"]);

    expect((await socialSend("/repos/cf-gitea-stub/ghost/stargazers")).status).toBe(404);
    expect((await socialSend("/repos/cf-gitea-stub/ghost/subscribers")).status).toBe(404);
  });

  it("requires tokens on the /user and /users listing routes", async () => {
    expect((await socialSend("/user/subscriptions")).status).toBe(401);
    expect((await socialSend("/users/cf-gitea-stub/starred")).status).toBe(401);
    expect((await socialSend("/users/cf-gitea-stub/subscriptions")).status).toBe(401);
    expect((await socialSend("/user/following")).status).toBe(401);
  });

  it("lists the doer's watched repos, a named user's starred/subscribed repos, and the doer's follows", async () => {
    await starRepo(env.DB, neighborId, REPO_ID, NOW);
    await watchRepo(env.DB, REPO_ID, neighborId, NOW);
    await followUser(env.DB, neighborId, 1);

    const ownSubscriptions = await socialSend("/user/subscriptions", authed(undefined, TOKEN_NEIGHBOR));
    expect(ownSubscriptions.status).toBe(200);
    const watched: Array<Record<string, unknown>> = await ownSubscriptions.json();
    expect(watched.map((entry) => entry.name)).toEqual(["extras"]);

    const namedStarred = await socialSend("/users/neighbor/starred", authed());
    expect(namedStarred.status).toBe(200);
    const starred: Array<Record<string, unknown>> = await namedStarred.json();
    expect(starred.map((entry) => entry.name)).toEqual(["extras"]);
    expect((await socialSend("/users/ghost/starred", authed())).status).toBe(404);

    const namedSubscriptions = await socialSend("/users/neighbor/subscriptions", authed());
    expect(namedSubscriptions.status).toBe(200);
    expect((await socialSend("/users/ghost/subscriptions", authed())).status).toBe(404);

    const following = await socialSend("/user/following", authed(undefined, TOKEN_NEIGHBOR));
    expect(following.status).toBe(200);
    const followed: Array<Record<string, unknown>> = await following.json();
    expect(followed.map((entry) => entry.login)).toEqual(["cf-gitea-stub"]);
  });
});

// ---------------------------------------------------------------------------
// Topic items
// ---------------------------------------------------------------------------

describe("PUT/DELETE /repos/{owner}/{repo}/topics/{topic} (topic-items)", () => {
  it("adds a topic (204, lower-cased, idempotent) and lists it", async () => {
    expect((await topicSend("/repos/cf-gitea-stub/extras/topics/Compat-Topic", authed({ method: "PUT" }))).status).toBe(204);
    expect((await topicSend("/repos/cf-gitea-stub/extras/topics/compat-topic", authed({ method: "PUT" }))).status).toBe(204);
    const raw = await env.DB.prepare("SELECT topic FROM repo_topics WHERE repo_id = ?1 ORDER BY topic").bind(REPO_ID).all();
    expect(raw.results).toEqual([{ topic: "compat-topic" }]);
  });

  it("422s invalid topic names with the hand-built body (no url field)", async () => {
    const response = await topicSend("/repos/cf-gitea-stub/extras/topics/Bad%20Topic", authed({ method: "PUT" }));
    expect(response.status).toBe(422);
    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body).sort()).toEqual(["invalidTopics", "message"]);
    expect(body.message).toBe("Topic name is invalid");
    expect(body.invalidTopics).toEqual(["bad topic"]);
  });

  it("deletes an existing topic (204) and 404s a missing one", async () => {
    await replaceRepoTopics(env.DB, REPO_ID, ["gone", "stays"]);
    expect((await topicSend("/repos/cf-gitea-stub/extras/topics/gone", authed({ method: "DELETE" }))).status).toBe(204);
    expect((await topicSend("/repos/cf-gitea-stub/extras/topics/never-there", authed({ method: "DELETE" }))).status).toBe(404);
    const raw = await env.DB.prepare("SELECT topic FROM repo_topics WHERE repo_id = ?1").bind(REPO_ID).all();
    expect(raw.results).toEqual([{ topic: "stays" }]);
  });

  it("gates writes on repo admins (403 for a read collaborator) and archived repos (423)", async () => {
    await addOrUpdateCollaborator(env.DB, REPO_ID, neighborId, "read", NOW);
    expect((await topicSend("/repos/cf-gitea-stub/extras/topics/compat", authed({ method: "PUT" }, TOKEN_NEIGHBOR))).status).toBe(403);
    await drizzle(env.DB)
      .update(repositoriesTable())
      .set({ isArchived: true })
      .where(eq(repositoriesTable().id, REPO_ID));
    expect((await topicSend("/repos/cf-gitea-stub/extras/topics/compat", authed({ method: "PUT" }))).status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// Hook delivery item
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/hooks/{id}/deliveries/{uuid} (hook-delivery)", () => {
  it("returns one delivery with its payloads; 404 on unknown hook or uuid", async () => {
    const hook = await createRepoHook(env.DB, REPO_ID, {
      type: "gitea",
      branch_filter: "*",
      config: { url: "https://hooks.invalid/extras", content_type: "json" },
      events: ["push"],
      active: false,
    });
    await drizzle(env.DB).insert(webhookDeliveries).values({
      hookId: hook.id,
      repoId: REPO_ID,
      uuid: "delivery-uuid-1",
      eventType: "push",
      eventGroup: "push",
      payloadContent: JSON.stringify({ zen: "seed" }),
      state: "delivered",
      isSucceed: true,
      requestContent: JSON.stringify({ headers: { "X-Gitea-Event": "push" }, body: "payload-bytes" }),
      responseContent: JSON.stringify({ status: 200, body: "ok" }),
      createdAt: NOW,
      deliveredAt: NOW,
    });

    const found = await deliverySend(`/repos/cf-gitea-stub/extras/hooks/${hook.id}/deliveries/delivery-uuid-1`, authed());
    expect(found.status).toBe(200);
    const body: Record<string, unknown> = await found.json();
    expect(body.uuid).toBe("delivery-uuid-1");
    expect(body.is_delivered).toBe(true);
    const request = body.request as Record<string, unknown>;
    expect(request).toBeDefined(); // the single read carries payloads

    expect((await deliverySend(`/repos/cf-gitea-stub/extras/hooks/${hook.id}/deliveries/other-uuid`, authed())).status).toBe(404);
    expect((await deliverySend("/repos/cf-gitea-stub/extras/hooks/999/deliveries/delivery-uuid-1", authed())).status).toBe(404);
    expect((await deliverySend("/repos/cf-gitea-stub/ghost/hooks/1/deliveries/delivery-uuid-1", authed())).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Issue-family extras (routes/issue-t2.ts)
// ---------------------------------------------------------------------------

describe("deprecated nested comment pair (issue-t2)", () => {
  it("PATCH edits the comment under the issue; a sibling-issue comment id 404s; system comments 204", async () => {
    const edited = await issueT2Send(
      `/repos/cf-gitea-stub/extras/issues/${issueA.index}/comments/${commentA}`,
      jsonAuthed({ body: "edited body" }, "PATCH"),
    );
    expect(edited.status).toBe(200);
    expect(((await edited.json<Record<string, unknown>>())).body).toBe("edited body");

    // commentA lives on issueA — the same id under issueB is the 404.
    expect(
      (await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueB.index}/comments/${commentA}`, jsonAuthed({ body: "x" }, "PATCH")))
        .status,
    ).toBe(404);

    const service = new IssuesService(env.DB);
    await service.closeIssue(issueB.id, { actorId: 1 });
    const closeComment = await drizzle(env.DB)
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, issueB.id), eq(comments.type, 2)))
      .limit(1)
      .then((rows) => rows[0]);
    const systemEdit = await issueT2Send(
      `/repos/cf-gitea-stub/extras/issues/${issueB.index}/comments/${closeComment?.id ?? 0}`,
      jsonAuthed({ body: "x" }, "PATCH"),
    );
    expect(systemEdit.status).toBe(204);
  });

  it("DELETE lets the poster remove their comment (204), 403s a non-poster non-writer, 404s afterwards", async () => {
    // commentA is the NEIGHBOR's — their own delete is the poster path (204);
    // the owner-seeded comment is the non-poster non-writer victim (403).
    const ownerComment = await new IssuesService(env.DB).addComment({
      issueId: issueA.id,
      posterId: 1,
      content: "owner-seeded comment",
    });
    expect(
      (
        await issueT2Send(
          `/repos/cf-gitea-stub/extras/issues/${issueA.index}/comments/${ownerComment.id}`,
          authed({ method: "DELETE" }, TOKEN_NEIGHBOR),
        )
      ).status,
    ).toBe(403);
    expect(
      (await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/comments/${commentA}`, authed({ method: "DELETE" }, TOKEN_NEIGHBOR)))
        .status,
    ).toBe(204);
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/comments/${commentA}`, authed({ method: "DELETE" }))).status)
      .toBe(404);
  });
});

describe("issue + comment reactions (issue-t2)", () => {
  it("POST creates 201 / repeats 200 with the Reaction body; GET lists; DELETE clears silently", async () => {
    const created = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/reactions`, jsonAuthed({ content: "+1" }, "POST"));
    expect(created.status).toBe(201);
    const createdBody: Record<string, unknown> = await created.json();
    expect(createdBody.content).toBe("+1");

    const repeated = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/reactions`, jsonAuthed({ content: "+1" }, "POST"));
    expect(repeated.status).toBe(200);

    const list = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/reactions`);
    expect(list.status).toBe(200);
    expect(list.headers.get("X-Total-Count")).toBe("1");
    const listed: Array<Record<string, unknown>> = await list.json();
    expect(listed[0]?.content).toBe("+1");

    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/reactions`, jsonAuthed({ content: "sparkles" }, "POST"))).status).toBe(403);
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/reactions`, jsonAuthed({ content: "+1" }, "DELETE"))).status).toBe(204);
    expect(await drizzle(env.DB).select().from(reactions).all()).toHaveLength(0);
  });

  it("comment reactions ride the comment id (404 on a foreign-repo comment id)", async () => {
    const created = await issueT2Send(
      `/repos/cf-gitea-stub/extras/issues/comments/${commentA}/reactions`,
      jsonAuthed({ content: "heart" }, "POST", TOKEN_NEIGHBOR),
    );
    expect(created.status).toBe(201);

    const list = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/comments/${commentA}/reactions`);
    expect(list.status).toBe(200);
    const listed: Array<Record<string, unknown>> = await list.json();
    expect(listed).toHaveLength(1);
    expect((listed[0]?.user as Record<string, unknown> | null)?.login).toBe("neighbor");

    expect((await issueT2Send("/repos/cf-gitea-stub/extras/issues/comments/999/reactions")).status).toBe(404);
    expect(
      (await issueT2Send(`/repos/cf-gitea-stub/extras/issues/comments/${commentA}/reactions`, jsonAuthed({ content: "heart" }, "DELETE", TOKEN_NEIGHBOR)))
        .status,
    ).toBe(204);
  });
});

describe("issue subscriptions (issue-t2)", () => {
  it("PUT subscribes (201) / repeats (200); GET lists; check renders WatchInfo; DELETE unsubscribes", async () => {
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions/neighbor`, authed({ method: "PUT" }, TOKEN_NEIGHBOR))).status).toBe(201);
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions/neighbor`, authed({ method: "PUT" }, TOKEN_NEIGHBOR))).status).toBe(200);

    const list = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions`);
    expect(list.status).toBe(200);
    const subscribers: Array<Record<string, unknown>> = await list.json();
    expect(subscribers.map((entry) => entry.login)).toEqual(["neighbor"]);

    const check = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions/check`, authed(undefined, TOKEN_NEIGHBOR));
    expect(check.status).toBe(200);
    const watch: Record<string, unknown> = await check.json();
    expect(watch.subscribed).toBe(true);
    expect(watch.ignored).toBe(false);
    expect(watch.url).toBe(`https://example.com/api/v1/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions`);

    // A third party may not flip someone else's subscription (the 403 arm).
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions/neighbor`, authed({ method: "DELETE" }))).status).toBe(403);
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions/neighbor`, authed({ method: "DELETE" }, TOKEN_NEIGHBOR))).status).toBe(201);
    expect((await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/subscriptions/ghost`, authed({ method: "PUT" }))).status).toBe(404);
  });
});

describe("pinned issues/pulls (issue-t2)", () => {
  it("lists pinned issues and pulls in pin order", async () => {
    await env.DB.prepare("INSERT INTO issue_pins (issue_id, repo_id, pin_order) VALUES (?1, ?2, 1), (?3, ?2, 2)")
      .bind(issueB.id, REPO_ID, issueA.id)
      .run();
    await env.DB.prepare("INSERT INTO issue_pins (issue_id, repo_id, pin_order) VALUES (?1, ?2, 0)")
      .bind(await pullRowId(), REPO_ID)
      .run();

    const pinnedIssues = await issueT2Send("/repos/cf-gitea-stub/extras/issues/pinned");
    expect(pinnedIssues.status).toBe(200);
    const pinned: Array<Record<string, unknown>> = await pinnedIssues.json();
    expect(pinned.map((entry) => entry.number)).toEqual([issueB.index, issueA.index]);

    const pinnedPulls = await issueT2Send("/repos/cf-gitea-stub/extras/pulls/pinned");
    expect(pinnedPulls.status).toBe(200);
    const pinnedPRs: Array<Record<string, unknown>> = await pinnedPulls.json();
    expect(pinnedPRs).toHaveLength(1);
    expect(pinnedPRs[0]?.number).toBe(pullIndex);
  });
});

describe("issue deadline (issue-t2)", () => {
  it("sets, updates and clears the deadline with 201 bodies; 400 on a bad date; 403 for non-writers", async () => {
    const set = await issueT2Send(
      `/repos/cf-gitea-stub/extras/issues/${issueA.index}/deadline`,
      jsonAuthed({ due_date: "2026-03-01T00:00:00Z" }, "POST"),
    );
    expect(set.status).toBe(201);
    expect(((await set.json<Record<string, unknown>>())).due_date).toBe("2026-03-01T00:00:00.000Z");

    const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueA.id)).limit(1).then((rows) => rows[0]);
    expect(row?.deadlineAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");

    const cleared = await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/deadline`, jsonAuthed({ due_date: null }, "POST"));
    expect(cleared.status).toBe(201);
    expect(((await cleared.json<Record<string, unknown>>())).due_date).toBeNull();

    expect(
      (await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/deadline`, jsonAuthed({ due_date: "not-a-date" }, "POST"))).status,
    ).toBe(400);
    expect(
      (await issueT2Send(`/repos/cf-gitea-stub/extras/issues/${issueA.index}/deadline`, jsonAuthed({ due_date: null }, "POST", TOKEN_NEIGHBOR))).status,
    ).toBe(403);
  });
});

describe("issue lock/unlock (issue-t2)", () => {
  it("locks (204) with a Lock system comment, is silent on re-lock, unlocks (204) with Unlock comment; 403 for non-writers", async () => {
    const lockPath = `/repos/cf-gitea-stub/extras/issues/${issueA.index}/lock`;
    expect((await issueT2Send(lockPath, jsonAuthed({ lock_reason: "off-topic" }, "PUT", TOKEN_NEIGHBOR))).status).toBe(403);
    expect((await issueT2Send(lockPath, jsonAuthed({ lock_reason: "off-topic" }, "PUT"))).status).toBe(204);
    expect((await issueT2Send(lockPath, jsonAuthed({ lock_reason: "off-topic" }, "PUT"))).status).toBe(204);
    expect((await issueT2Send(lockPath, authed({ method: "DELETE" }, TOKEN_NEIGHBOR))).status).toBe(403);
    expect((await issueT2Send(lockPath, authed({ method: "DELETE" }))).status).toBe(204);

    const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueA.id)).limit(1).then((rows) => rows[0]);
    expect(row?.isLocked).toBe(false);
    const lockComments = await drizzle(env.DB)
      .select({ type: comments.type })
      .from(comments)
      .where(eq(comments.issueId, issueA.id))
      .all();
    expect(lockComments.map((entry) => entry.type).filter((type) => type === 23 || type === 24)).toEqual([23, 24]);
  });
});

/** The seeded pull's underlying issues-row id (pull_requests keys on it). */
async function pullRowId(): Promise<number> {
  const row = await drizzle(env.DB)
    .select({ issueId: issues.id })
    .from(issues)
    .where(and(eq(issues.repoId, REPO_ID), eq(issues.isPull, true)))
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined) {
    throw new Error("seeded pull row missing");
  }
  return row.issueId;
}
