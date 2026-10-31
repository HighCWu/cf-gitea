/**
 * Tier-2 notifications on real D1 (the frozen contract's `notification` tag,
 * 7 ops — routes/notifications.ts). Standalone mount per the landed
 * route-module convention (tier2-extras.test.ts / topics.test.ts): the
 * register function takes the same requireAuth middleware the router passes,
 * the app is a fresh OpenAPIHono with the Gitea error handler.
 *
 * The threads are DERIVED from real issue/comment activity (module doc in
 * routes/notifications.ts); the seeds control every event timestamp through
 * the IssuesService `now` seam so the unread/read arithmetic against the
 * notification_states rows (migration 0011) is deterministic:
 *
 *   owner    (id 1, TOKEN_OWNER)   — repo owner, NOT watching, comments
 *   neighbor (id 2, TOKEN_NEIGHBOR) — watches the repo, authors the issues
 *   carol    (id 3, TOKEN_CAROL)    — no relationship to the repo (403 arm)
 *   admin    (id 4, TOKEN_ADMIN)    — site admin, not a recipient (admin arm)
 *
 * Base seed arithmetic (the author-exclusion rule):
 *   owner   → threads A and B, both lastForeign = T1 (the neighbor's issue
 *             creations); the owner's own T2 comment never bumps their own
 *             thread → updated_at T1, unread.
 *   neighbor→ thread A only, lastForeign = T2 (the owner's comment; the T3
 *             reply is self-authored); B has no foreign activity → no thread.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { pullRequests, repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerNotificationsRoutes } from "./notifications";
import { IssuesService } from "../../issues/service";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";
import { watchRepo, watchRepoByMode, WatchMode } from "../services/repo-watchers";

const TOKEN_OWNER = "owner-token";
const TOKEN_NEIGHBOR = "neighbor-token";
const TOKEN_CAROL = "carol-token";
const TOKEN_ADMIN = "admin-token";
const TOKEN_WATCHER = "watcher-token";

const T1 = new Date("2026-03-01T00:00:00Z"); // issue creations (by neighbor)
const T2 = new Date("2026-03-05T00:00:00Z"); // owner's comment on A
const T3 = new Date("2026-03-09T00:00:00Z"); // neighbor's reply on A (self)
const SEED = new Date("2026-02-01T00:00:00Z");

const REPO_ID = "7200";
const REPO2_ID = "7201";
const OWNER_NS = "cf-gitea-stub";
const SLUG = "extras";

let neighborId = 0;

/** Issue handles (re-seeded per test). */
let issueA = { id: 0, index: 0 };
let issueB = { id: 0, index: 0 };

function userPayload(id: number, username: string, isAdmin: boolean): User {
  return {
    id,
    login: username,
    email: "",
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: SEED.toISOString(),
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

function resolver(): AuthResolver {
  return {
    resolveToken: async (token) => {
      if (token === TOKEN_OWNER) {
        return userPayload(1, OWNER_NS, false);
      }
      const login =
        token === TOKEN_NEIGHBOR
          ? "neighbor"
          : token === TOKEN_CAROL
            ? "carol"
            : token === TOKEN_ADMIN
              ? "root-admin"
              : token === TOKEN_WATCHER
                ? "watcher"
                : null;
      if (login === null) {
        return null;
      }
      const row = await env.DB
        .prepare("SELECT id, username, is_admin FROM users WHERE username_lower = ?1")
        .bind(login)
        .first<{ id: number; username: string; is_admin: number }>();
      return row === null ? null : userPayload(row.id, row.username, row.is_admin === 1);
    },
  };
}

function familyApp() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerNotificationsRoutes(app, createTokenAuthMiddleware(resolver()));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const send = familyApp();

const authed = (init?: RequestInit, token = TOKEN_OWNER): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

/** Fresh rows per test: four users, two public repos; the neighbor watches
 *  the first; issue A (neighbor-authored, T1) with the owner's comment (T2)
 *  and the neighbor's reply (T3); issue B (neighbor-authored, T1). */
beforeEach(async () => {
  for (const table of [
    "notification_states",
    "issue_subscriptions",
    "issue_pins",
    "comments",
    "issue_labels",
    "pull_requests",
    "issues",
    "repo_topics",
    "repo_watchers",
    "repo_collaborators",
    "repo_settings",
    "repo_counters",
    "stars",
    "follows",
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
  const seeded = await drizzle(env.DB)
    .insert(users)
    .values([
      { username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: SEED },
      { username: "carol", usernameLower: "carol", status: "active", createdAt: SEED },
      { username: "root-admin", usernameLower: "root-admin", status: "active", isAdmin: true, createdAt: SEED },
    ])
    .returning({ id: users.id, username: users.username })
    .all();
  neighborId = seeded.find((row) => row.username === "neighbor")!.id;

  await drizzle(env.DB).insert(repositories).values([
    {
      id: REPO_ID,
      storageKey: `r_${REPO_ID}`,
      ownerNamespace: OWNER_NS,
      ownerId: 1,
      slug: SLUG,
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: SEED,
    },
    {
      id: REPO2_ID,
      storageKey: `r_${REPO2_ID}`,
      ownerNamespace: OWNER_NS,
      ownerId: 1,
      slug: "second",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: SEED,
    },
  ]);

  await watchRepo(env.DB, REPO_ID, neighborId, SEED);

  const service = new IssuesService(env.DB);
  const a = await service.createIssue({ repoId: REPO_ID, title: "alpha", content: "first", posterId: neighborId, now: T1 });
  await service.addComment({ issueId: a.id, posterId: 1, content: "owner comment", now: T2 });
  await service.addComment({ issueId: a.id, posterId: neighborId, content: "neighbor reply", now: T3 });
  const b = await service.createIssue({ repoId: REPO_ID, title: "beta", content: "second", posterId: neighborId, now: T1 });
  issueA = { id: a.id, index: a.index };
  issueB = { id: b.id, index: b.index };
});

interface Thread {
  id: number;
  unread: boolean;
  pinned: boolean;
  updated_at: string;
  url: string;
  repository: Record<string, unknown> & { permissions?: unknown };
  subject: Record<string, unknown>;
}

/** The extended seed used by the filter tests: a PR (neighbor, T2 — foreign
 *  for the owner) and an issue in the SECOND repo (neighbor, T1). */
async function seedPullAndSecondRepo(): Promise<{ pullIssueId: number; otherIssueId: number }> {
  const service = new IssuesService(env.DB);
  const pull = await service.createPullRequest({
    repoId: REPO_ID,
    headRepoId: REPO_ID,
    baseBranch: "main",
    headBranch: "topic",
    title: "seed pull",
    posterId: neighborId,
    now: T2,
  });
  const other = await service.createIssue({ repoId: REPO2_ID, title: "elsewhere", posterId: neighborId, now: T1 });
  return { pullIssueId: pull.issue.id, otherIssueId: other.id };
}

// ---------------------------------------------------------------------------
// GET /notifications (notifyGetList)
// ---------------------------------------------------------------------------

describe("GET /notifications (notifyGetList)", () => {
  it("derives the owner's threads from foreign activity with pagination headers", async () => {
    const response = await send("/notifications", authed());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("2");
    const threads = (await response.json<Thread[]>());
    // Owner view: A's foreign activity is the neighbor's creation (T1) AND
    // their T3 reply (the owner's own T2 comment is invisible to them), so
    // A sorts first; B only has the T1 creation.
    expect(threads.map((thread) => thread.id)).toEqual([issueA.id, issueB.id]);
    expect(threads.map((thread) => thread.unread)).toEqual([true, true]);
    expect(threads.map((thread) => thread.updated_at)).toEqual(["2026-03-09T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
    expect(threads[0]?.url).toBe(`https://example.com/api/v1/notifications/threads/${issueA.id}`);
  });

  it("a Dont watch row stops qualifying the watcher as a recipient; a picked-include Custom row still qualifies (mode-aware recipientExpr)", async () => {
    // A user whose ONLY recipient claim is the watch row (the seeded
    // issues are authored by the neighbor, so poster/participant claims
    // stay out of the picture).
    const watcherRows = await drizzle(env.DB)
      .insert(users)
      .values({ username: "watcher", usernameLower: "watcher", status: "active", createdAt: SEED })
      .returning({ id: users.id })
      .all();
    const watcherId = watcherRows[0]!.id;
    const foreign = await new IssuesService(env.DB).createIssue({
      repoId: REPO_ID,
      title: "foreign activity",
      posterId: neighborId,
      now: T1,
    });

    // The Normal watch qualifies (the baseline the Dont exclusion erases) —
    // the seeded A/B threads qualify through the same row (neighbor-authored
    // = foreign activity), so assert membership.
    await watchRepo(env.DB, REPO_ID, watcherId, SEED);
    const listed = await send("/notifications", authed(undefined, TOKEN_WATCHER));
    expect((await listed.json<Thread[]>()).map((thread) => thread.id)).toContain(foreign.id);

    // A picked-include Custom row still qualifies (mode <> Dont — the
    // per-type include matching is not part of recipientExpr, deviation 4).
    await watchRepoByMode(env.DB, REPO_ID, watcherId, WatchMode.Custom, SEED);
    const custom = await send("/notifications", authed(undefined, TOKEN_WATCHER));
    expect((await custom.json<Thread[]>()).map((thread) => thread.id)).toContain(foreign.id);

    // The Dont row (the ignore/mute state — watch.go:164-165's landing)
    // disqualifies the watcher: the list empties and the thread endpoint
    // answers the non-recipient 403.
    await watchRepoByMode(env.DB, REPO_ID, watcherId, WatchMode.Dont, SEED);
    expect((await (await send("/notifications", authed(undefined, TOKEN_WATCHER))).json<Thread[]>()).length).toBe(0);
    const forbidden = await send(`/notifications/threads/${foreign.id}`, authed({ method: "PATCH" }, TOKEN_WATCHER));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(
      expect.objectContaining({
        message: `only user itself and admin are allowed to read/change this thread ${foreign.id}`,
      }),
    );
  });

  it("serializes the subject (URLs, latest comment) and strips repository.permissions", async () => {
    const response = await send("/notifications", authed(undefined, TOKEN_NEIGHBOR));
    expect(response.status).toBe(200);
    const threads = (await response.json<Thread[]>());
    // The neighbor authored both issues; only A has foreign activity (the
    // owner's T2 comment — the T3 reply is self-authored, invisible).
    expect(threads.map((thread) => thread.id)).toEqual([issueA.id]);
    expect(threads[0]?.updated_at).toBe("2026-03-05T00:00:00.000Z");
    expect(threads[0]?.subject.title).toBe("alpha");
    expect(threads[0]?.subject.type).toBe("Issue");
    expect(threads[0]?.subject.state).toBe("open");
    expect(threads[0]?.subject.url).toBe(`https://example.com/api/v1/repos/${OWNER_NS}/${SLUG}/issues/${issueA.index}`);
    expect(threads[0]?.subject.html_url).toBe(`https://example.com/${OWNER_NS}/${SLUG}/issues/${issueA.index}`);
    expect(String(threads[0]?.subject.latest_comment_url)).toMatch(/\/issues\/comments\/\d+$/);
    expect(String(threads[0]?.subject.latest_comment_html_url)).toMatch(/#issuecomment-\d+$/);
    expect(threads[0]?.repository.name).toBe(SLUG);
    expect(threads[0]?.repository.full_name).toBe(`${OWNER_NS}/${SLUG}`);
    expect(threads[0]?.repository.permissions).toBeUndefined(); // upstream nulls the block
  });

  it("filters by status-types, subject-type, since/before and paginates", async () => {
    const { pullIssueId, otherIssueId } = await seedPullAndSecondRepo();

    const all = await send("/notifications", authed());
    expect(all.headers.get("X-Total-Count")).toBe("4"); // A(T3), PR(T2), elsewhere/B (T1)
    const allThreads = (await all.json<Thread[]>());
    expect(allThreads.map((thread) => thread.id)).toEqual([issueA.id, pullIssueId, otherIssueId, issueB.id]);

    const pulls = await send("/notifications?subject-type=pull", authed());
    const pullThreads = (await pulls.json<Thread[]>());
    expect(pullThreads.map((thread) => thread.id)).toEqual([pullIssueId]);
    expect(pullThreads[0]?.subject.type).toBe("Pull");
    expect(pullThreads[0]?.subject.state).toBe("open");
    expect(String(pullThreads[0]?.subject.html_url)).toContain("/pulls/");
    expect(String(pullThreads[0]?.subject.url)).toContain("/issues/"); // Issue.APIURL stays /issues/

    const issuesOnly = await send("/notifications?subject-type=issue", authed());
    const issueThreads = (await issuesOnly.json<Thread[]>());
    expect(issueThreads.map((thread) => thread.id)).toEqual([issueA.id, otherIssueId, issueB.id]);

    // commit/repository subjects have no source in the derived model.
    expect(await (await send("/notifications?subject-type=commit", authed())).json()).toEqual([]);
    // Unknown-only filters are no-ops (upstream empty-slice semantics).
    expect(await (await send("/notifications?subject-type=bogus", authed())).json()).toHaveLength(4);
    expect(await (await send("/notifications?status-types=bogus", authed())).json()).toHaveLength(4);

    const since = (await (await send("/notifications?since=2026-03-02T00:00:00Z", authed())).json<Thread[]>());
    expect(since.map((thread) => thread.id)).toEqual([issueA.id, pullIssueId]); // T3 and T2 survive
    const before = (await (await send("/notifications?before=2026-03-02T00:00:00Z", authed())).json<Thread[]>());
    expect(before).toHaveLength(2); // elsewhere and B (both T1)

    expect((await send("/notifications?since=nope", authed())).status).toBe(422);

    const page2 = await send("/notifications?limit=1&page=2", authed());
    expect(page2.headers.get("X-Total-Count")).toBe("4");
    expect(page2.headers.get("Link")).toContain('rel="prev"');
    const paged = (await page2.json<Thread[]>());
    expect(paged.map((thread) => thread.id)).toEqual([pullIssueId]);
  });

  it("shows closed subjects as closed and merged PRs as merged", async () => {
    const service = new IssuesService(env.DB);
    await service.closeIssue(issueB.id, { actorId: 1 });
    const pull = await new IssuesService(env.DB).createPullRequest({
      repoId: REPO_ID,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
      title: "merge me",
      posterId: neighborId,
      now: T2,
    });
    await drizzle(env.DB).update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, pull.pullRequest.id));

    const response = await send("/notifications", authed());
    const threads = (await response.json<Thread[]>());
    const closed = threads.find((thread) => thread.id === issueB.id);
    const merged = threads.find((thread) => thread.id === pull.issue.id);
    expect(closed?.subject.state).toBe("closed");
    expect(merged?.subject.state).toBe("merged");
    expect(merged?.subject.type).toBe("Pull");
  });
});

// ---------------------------------------------------------------------------
// Read-state lifecycle (PATCH thread, re-unread on new activity)
// ---------------------------------------------------------------------------

describe("PATCH /notifications/threads/{id} (notifyReadThread)", () => {
  it("marks a thread read (205, empty body), hides it from the default list, and /new drops", async () => {
    const patched = await send(`/notifications/threads/${issueA.id}`, authed({ method: "PATCH" }));
    expect(patched.status).toBe(205);
    expect(await patched.text()).toBe(""); // deviation 6: no 205 body on this runtime

    const list = await send("/notifications", authed());
    const threads = (await list.json<Thread[]>());
    expect(threads.map((thread) => thread.id)).toEqual([issueB.id]); // A read → default-hidden

    const all = await send("/notifications?all=true", authed());
    const every = (await all.json<Thread[]>());
    expect(every.find((thread) => thread.id === issueA.id)?.unread).toBe(false);

    const count = await send("/notifications/new", authed());
    expect(await count.json()).toEqual({ new: 1 });

    // to-status=pinned pins (implies non-unread, listed by default — the
    // still-unread B stays listed too).
    const pinned = await send(`/notifications/threads/${issueA.id}?to-status=pinned`, authed({ method: "PATCH" }));
    expect(pinned.status).toBe(205);
    const pinnedList = (await (await send("/notifications", authed())).json<Thread[]>());
    expect(pinnedList.map((thread) => thread.id)).toEqual([issueA.id, issueB.id]);
    expect(pinnedList[0]?.pinned).toBe(true);
    expect(pinnedList[0]?.unread).toBe(false);
    expect((await send("/notifications?status-types=read", authed())).headers.get("X-Total-Count")).toBe("0");

    // Back to unread.
    await send(`/notifications/threads/${issueA.id}?to-status=unread`, authed({ method: "PATCH" }));
    const reset = (await (await send("/notifications", authed())).json<Thread[]>());
    expect(reset.find((thread) => thread.id === issueA.id)?.unread).toBe(true);
    expect(reset.find((thread) => thread.id === issueA.id)?.pinned).toBe(false);
  });

  it("re-marks a read thread unread when foreign activity lands after the read marker", async () => {
    await send(`/notifications/threads/${issueA.id}`, authed({ method: "PATCH" }));
    // The owner's own comments are invisible to them; a FOREIGN comment (the
    // neighbor's) re-marks the thread. The read marker is the wall-clock
    // mark time, so the new activity must be stamped after it — one minute
    // into the future from the PATCH above.
    const after = new Date(Date.now() + 60_000);
    await new IssuesService(env.DB).addComment({ issueId: issueA.id, posterId: neighborId, content: "after read", now: after });
    const list = await send("/notifications", authed());
    const threads = (await list.json<Thread[]>());
    expect(threads.map((thread) => thread.id)).toEqual([issueA.id, issueB.id]); // A newest
    expect(threads.find((thread) => thread.id === issueA.id)?.unread).toBe(true);
    expect(threads.find((thread) => thread.id === issueA.id)?.updated_at).toBe(
      new Date(Math.floor(after.getTime() / 1000) * 1000).toISOString(),
    );
  });

  it("404s a missing thread, a non-recipient 403s, the admin bypasses, a no-mailbox thread 404s", async () => {
    expect((await send("/notifications/threads/999999", authed({ method: "PATCH" }))).status).toBe(404);
    const body = (await (await send("/notifications/threads/999999", authed())).json<Record<string, unknown>>());
    expect(body.message).toBe("notification does not exist [id: 999999]");

    const forbidden = await send(`/notifications/threads/${issueA.id}`, authed({ method: "PATCH" }, TOKEN_CAROL));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(
      expect.objectContaining({
        message: `only user itself and admin are allowed to read/change this thread ${issueA.id}`,
      }),
    );

    // The admin is not a recipient — the upstream getThread admin bypass.
    expect((await send(`/notifications/threads/${issueA.id}`, authed(undefined, TOKEN_ADMIN))).status).toBe(200);

    // An issue with no foreign activity for the caller is no mailbox entry.
    const own = await new IssuesService(env.DB).createIssue({
      repoId: REPO_ID,
      title: "self-made",
      posterId: 1,
      now: T1,
    });
    expect((await send(`/notifications/threads/${own.id}`, authed())).status).toBe(404);
    // The issue row exists for the ADMIN though (any-activity fallback).
    expect((await send(`/notifications/threads/${own.id}`, authed(undefined, TOKEN_ADMIN))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PUT /notifications (notifyReadList) — the last_read_at sweep semantics
// ---------------------------------------------------------------------------

describe("PUT /notifications (notifyReadList)", () => {
  it("marks only threads at/before last_read_at; defaults to the unread ones", async () => {
    const { pullIssueId, otherIssueId } = await seedPullAndSecondRepo();
    // last_read_at between T1 and T2: B and elsewhere (T1) get marked; A
    // (T3, the neighbor's reply) and the PR (T2) are "updated since" and
    // stay untouched.
    const marked = await send("/notifications?last_read_at=2026-03-01T12:00:00Z", authed({ method: "PUT" }));
    expect(marked.status).toBe(205);
    expect(await marked.text()).toBe("");

    const count = await send("/notifications/new", authed());
    expect(await count.json()).toEqual({ new: 2 }); // A and the PR

    const list = (await (await send("/notifications?all=true", authed())).json<Thread[]>());
    expect(list.find((thread) => thread.id === pullIssueId)?.unread).toBe(true);
    expect(list.find((thread) => thread.id === issueA.id)?.unread).toBe(true);
    expect(list.find((thread) => thread.id === issueB.id)?.unread).toBe(false);
    expect(list.find((thread) => thread.id === otherIssueId)?.unread).toBe(false);

    // Bad last_read_at → 400 (notify/user.go:137).
    expect((await send("/notifications?last_read_at=nope", authed({ method: "PUT" }))).status).toBe(400);

    // A bare PUT sweeps the unread ones (default status-types=[unread] —
    // the already-read trio stays read); to-status=unread flips everything.
    await send("/notifications", authed({ method: "PUT" }));
    expect(await (await send("/notifications/new", authed())).json()).toEqual({ new: 0 });
    await send("/notifications?all=true&to-status=unread", authed({ method: "PUT" }));
    expect(await (await send("/notifications/new", authed())).json()).toEqual({ new: 4 });
  });

  it("pins everything with all=true and reads the pinned subset via status-types", async () => {
    const pinned = await send("/notifications?all=true&to-status=pinned", authed({ method: "PUT" }));
    expect(pinned.status).toBe(205);

    const list = (await (await send("/notifications", authed())).json<Thread[]>());
    expect(list).toHaveLength(2); // pinned listed by the unread+pinned default
    expect(list.map((thread) => thread.pinned)).toEqual([true, true]);
    expect(list.map((thread) => thread.unread)).toEqual([false, false]);
    expect((await send("/notifications?status-types=unread", authed())).headers.get("X-Total-Count")).toBe("0");

    // Only the pinned subset flips to read.
    await send("/notifications?status-types=pinned&to-status=read", authed({ method: "PUT" }));
    const after = (await (await send("/notifications?all=true", authed())).json<Thread[]>());
    expect(after.map((thread) => thread.unread)).toEqual([false, false]);
    expect(after.map((thread) => thread.pinned)).toEqual([false, false]);
    expect((await send("/notifications", authed())).headers.get("X-Total-Count")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// GET /notifications/new (notifyNewAvailable)
// ---------------------------------------------------------------------------

describe("GET /notifications/new (notifyNewAvailable)", () => {
  it("counts unread threads only (pinned excluded)", async () => {
    expect(await (await send("/notifications/new", authed())).json()).toEqual({ new: 2 });
    await send(`/notifications/threads/${issueA.id}?to-status=pinned`, authed({ method: "PATCH" }));
    expect(await (await send("/notifications/new", authed())).json()).toEqual({ new: 1 });
  });
});

// ---------------------------------------------------------------------------
// GET /notifications/threads/{id} (notifyGetThread)
// ---------------------------------------------------------------------------

describe("GET /notifications/threads/{id} (notifyGetThread)", () => {
  it("returns the caller's own view of the thread by issue id", async () => {
    const response = await send(`/notifications/threads/${issueA.id}`, authed());
    expect(response.status).toBe(200);
    const thread = (await response.json<Thread>());
    expect(thread.id).toBe(issueA.id);
    expect(thread.unread).toBe(true);
    expect(thread.pinned).toBe(false);
    expect(thread.updated_at).toBe("2026-03-09T00:00:00.000Z"); // the owner's foreign view (T3)
    expect(thread.url).toBe(`https://example.com/api/v1/notifications/threads/${issueA.id}`);
    expect(thread.subject.title).toBe("alpha");

    // The same id resolves to the NEIGHBOR's own view (different marker).
    const neighborView = (await (await send(`/notifications/threads/${issueA.id}`, authed(undefined, TOKEN_NEIGHBOR))).json<Thread>());
    expect(neighborView.updated_at).toBe("2026-03-05T00:00:00.000Z");

    expect((await send("/notifications/threads/999999", authed())).status).toBe(404);
    expect((await send(`/notifications/threads/${issueA.id}`, authed(undefined, TOKEN_CAROL))).status).toBe(403);
    expect((await send(`/notifications/threads/${issueA.id}`, authed(undefined, TOKEN_ADMIN))).status).toBe(200);
    expect((await send("/notifications/threads/not-a-number", authed())).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Repo-scoped variants (notifyGetRepoList / notifyReadRepoList)
// ---------------------------------------------------------------------------

describe("GET/PUT /repos/{owner}/{repo}/notifications", () => {
  it("scopes the listing and the mark sweep to the repo", async () => {
    const { otherIssueId } = await seedPullAndSecondRepo();

    const repo1 = await send(`/repos/${OWNER_NS}/${SLUG}/notifications`, authed());
    expect(repo1.status).toBe(200);
    expect(repo1.headers.get("X-Total-Count")).toBe("3"); // PR + A + B, all in repo 1
    const repo2 = await send("/repos/cf-gitea-stub/second/notifications", authed());
    const repo2Threads = (await repo2.json<Thread[]>());
    expect(repo2Threads.map((thread) => thread.id)).toEqual([otherIssueId]);

    // Missing / invisible repo → the anti-enumeration 404.
    expect((await send("/repos/cf-gitea-stub/ghost/notifications", authed())).status).toBe(404);

    // Marking repo 1 leaves repo 2 untouched.
    const marked = await send(`/repos/${OWNER_NS}/${SLUG}/notifications`, authed({ method: "PUT" }));
    expect(marked.status).toBe(205);
    expect(await (await send("/notifications/new", authed())).json()).toEqual({ new: 1 });
    const still = (await (await send("/notifications?all=true", authed())).json<Thread[]>());
    expect(still.find((thread) => thread.id === otherIssueId)?.unread).toBe(true);
    expect(still.find((thread) => thread.id === issueA.id)?.unread).toBe(false);
  });

  it("supports the same filters and the last_read_at sweep as the global routes", async () => {
    await seedPullAndSecondRepo();
    const pulls = await send(`/repos/${OWNER_NS}/${SLUG}/notifications?subject-type=pull`, authed());
    const pullThreads = (await pulls.json<Thread[]>());
    expect(pullThreads).toHaveLength(1);
    expect(pullThreads[0]?.subject.type).toBe("Pull");

    const marked = await send(`/repos/${OWNER_NS}/${SLUG}/notifications?last_read_at=2026-03-01T12:00:00Z`, authed({ method: "PUT" }));
    expect(marked.status).toBe(205);
    // Only B (T1) falls under the cutoff in repo 1 — A (T3) and the PR (T2)
    // are "updated since"; repo 2 was never touched, so its T1 thread is
    // still unread there.
    expect((await send(`/repos/${OWNER_NS}/${SLUG}/notifications`, authed())).headers.get("X-Total-Count")).toBe("2");
    expect((await send("/repos/cf-gitea-stub/second/notifications", authed())).headers.get("X-Total-Count")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Auth (upstream reqToken on every operation)
// ---------------------------------------------------------------------------

describe("notifications auth", () => {
  it("401s anonymous callers on all seven operations", async () => {
    expect((await send("/notifications")).status).toBe(401);
    expect((await send("/notifications", { method: "PUT" })).status).toBe(401);
    expect((await send("/notifications/new")).status).toBe(401);
    expect((await send(`/notifications/threads/${issueA.id}`)).status).toBe(401);
    expect((await send(`/notifications/threads/${issueA.id}`, { method: "PATCH" })).status).toBe(401);
    expect((await send(`/repos/${OWNER_NS}/${SLUG}/notifications`)).status).toBe(401);
    expect((await send(`/repos/${OWNER_NS}/${SLUG}/notifications`, { method: "PUT" })).status).toBe(401);
    const body = (await (await send("/notifications")).json<Record<string, unknown>>());
    expect(body.message).toBe("token is required");
  });
});

