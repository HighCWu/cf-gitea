/**
 * The issue_user carrier — the write/read round trip over real D1
 * (specs/email-outbound.md §13.2, the recorded HANDOFF this suite closes).
 *
 * Write arms cite upstream at pin fc493688: `UpdateIssueMentions`
 * (models/issues/issue_update.go:515-527) → `UpdateIssueUsersByMentions`
 * (models/issues/issue_user.go:64-86 — the single-column `is_mentioned`
 * upsert; the pin has NO un-mention) and `GetIssueMentionIDs`
 * (issue_user.go:89-96). The emit-position arms pin the threading: the
 * create services run FindAndUpdateIssueMentions BEFORE the notify and
 * with no mail-env notion (services/issue/comments.go:81,
 * services/issue/issue.go:68, services/pull/pull.go:184), so the carrier
 * rows land with `new IssuesService(env.DB)` — no mail env constructed.
 * The read arm pins the derived mailbox's mention predicate
 * (routes/notifications.ts recipientExpr — upstream's mail fan-out mails
 * the mentions as their own batch, services/mailer/mail_issue.go:99-105).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { issueUsers, issues, pullRequests, repoCounters, repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../../api/auth";
import { giteaErrorHandler } from "../../api/errors";
import type { ApiEnv } from "../../api/env";
import type { User } from "../../api/models/user";
import { registerNotificationsRoutes } from "../../api/routes/notifications";
import { IssuesService } from "../../issues/service";
import { getIssueMentionIds, updateIssueMentions } from "./carrier";

const AUTHOR_ID = 10;
const ALICE_ID = 20;
const BYSTANDER_ID = 30;
const OWNER_ID = 1;

const REPO_ID = "9500";
const OWNER_NS = "stub-owner";

const T0 = new Date("2026-04-01T00:00:00Z");

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "issue_user",
    "notification_states",
    "issue_subscriptions",
    "comments",
    "pull_requests",
    "issues",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await drizzle(env.DB).insert(users).values([
    { id: OWNER_ID, username: OWNER_NS, usernameLower: OWNER_NS, status: "active", createdAt: T0 },
    { id: AUTHOR_ID, username: "author", usernameLower: "author", status: "active", createdAt: T0 },
    { id: ALICE_ID, username: "alice", usernameLower: "alice", status: "active", createdAt: T0 },
    { id: BYSTANDER_ID, username: "bystander", usernameLower: "bystander", status: "active", createdAt: T0 },
  ]);
  await drizzle(env.DB).insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: OWNER_NS,
    ownerId: OWNER_ID,
    slug: "mentions",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: T0,
  });
});

function userRow(id: number) {
  return drizzle(env.DB).select().from(users).where(eq(users.id, id)).get();
}

describe("updateIssueMentions — the UpdateIssueUsersByMentions upsert (issue_user.go:64-86)", () => {
  it("a mention writes the carrier row: is_mentioned=1, is_read=0 (the fresh-row shape)", async () => {
    const alice = await userRow(ALICE_ID);
    if (alice === undefined) throw new Error("fixture missing");
    await updateIssueMentions(env.DB, 501, [alice]);
    const row = await drizzle(env.DB)
      .select()
      .from(issueUsers)
      .where(and(eq(issueUsers.issueId, 501), eq(issueUsers.userId, ALICE_ID)))
      .get();
    expect(row).toBeDefined();
    expect(row?.isMentioned).toBe(true);
    expect(row?.isRead).toBe(false);
  });

  it("an empty list is the fast-path no-op (issue_update.go:517-519) — zero rows", async () => {
    await updateIssueMentions(env.DB, 502, []);
    expect(await drizzle(env.DB).select().from(issueUsers).all()).toEqual([]);
  });

  it("the same user twice in one call lands ONE row (upstream loops per uid — a re-update, not a duplicate)", async () => {
    const alice = await userRow(ALICE_ID);
    if (alice === undefined) throw new Error("fixture missing");
    await updateIssueMentions(env.DB, 503, [alice, alice]);
    const rows = await drizzle(env.DB).select().from(issueUsers).where(eq(issueUsers.issueId, 503)).all();
    expect(rows).toHaveLength(1);
  });

  it("a re-mention over the unique arbiter stays ONE row (upstream's Get→update arm)", async () => {
    const alice = await userRow(ALICE_ID);
    if (alice === undefined) throw new Error("fixture missing");
    await updateIssueMentions(env.DB, 504, [alice]);
    await updateIssueMentions(env.DB, 504, [alice]);
    const rows = await drizzle(env.DB).select().from(issueUsers).where(eq(issueUsers.issueId, 504)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isMentioned).toBe(true);
  });

  it("a re-mention NEVER flips is_read — upstream updates Cols(\"is_mentioned\") only (issue_user.go:77)", async () => {
    const alice = await userRow(ALICE_ID);
    if (alice === undefined) throw new Error("fixture missing");
    await updateIssueMentions(env.DB, 505, [alice]);
    await drizzle(env.DB).update(issueUsers).set({ isRead: true }).where(eq(issueUsers.issueId, 505));
    await updateIssueMentions(env.DB, 505, [alice]);
    const row = await drizzle(env.DB).select().from(issueUsers).where(eq(issueUsers.issueId, 505)).get();
    expect(row?.isRead).toBe(true);
    expect(row?.isMentioned).toBe(true);
  });
});

describe("getIssueMentionIds — the GetIssueMentionIDs read (issue_user.go:89-96)", () => {
  it("returns exactly the is_mentioned uids; an is_read-only row is not a mention", async () => {
    const alice = await userRow(ALICE_ID);
    const bystander = await userRow(BYSTANDER_ID);
    if (alice === undefined || bystander === undefined) throw new Error("fixture missing");
    await updateIssueMentions(env.DB, 506, [alice]);
    // A non-mention carrier row (the staged NewIssueUsers seed shape):
    // is_read tracking only — never answers the mentioned read.
    await drizzle(env.DB).insert(issueUsers).values({ userId: BYSTANDER_ID, issueId: 506 });
    expect(await getIssueMentionIds(env.DB, 506)).toEqual([ALICE_ID]);
  });

  it("another issue's rows stay on the other side of the issue_id filter", async () => {
    const alice = await userRow(ALICE_ID);
    if (alice === undefined) throw new Error("fixture missing");
    await updateIssueMentions(env.DB, 507, [alice]);
    expect(await getIssueMentionIds(env.DB, 999)).toEqual([]);
  });
});

describe("the emit positions — FindAndUpdateIssueMentions threaded ungated (comments.go:81, issue.go:68, pull.go:184)", () => {
  it("issue create persists the body's mentions with NO mail env (services/issue/issue.go:68)", async () => {
    const service = new IssuesService(env.DB);
    const issue = await service.createIssue({
      repoId: REPO_ID,
      title: "carrier",
      content: "ping @alice — this matters",
      posterId: AUTHOR_ID,
      now: T0,
    });
    expect(await getIssueMentionIds(env.DB, issue.id)).toEqual([ALICE_ID]);
  });

  it("comment create persists the comment's mentions with NO mail env (services/issue/comments.go:81)", async () => {
    const service = new IssuesService(env.DB);
    const issue = await service.createIssue({
      repoId: REPO_ID,
      title: "carrier",
      content: "no mentions here",
      posterId: AUTHOR_ID,
      now: T0,
    });
    await service.addComment({ issueId: issue.id, posterId: AUTHOR_ID, content: "fyi @alice", now: T0 });
    expect(await getIssueMentionIds(env.DB, issue.id)).toEqual([ALICE_ID]);
  });

  it("PR create persists the body's mentions with NO mail env (services/pull/pull.go:184)", async () => {
    const service = new IssuesService(env.DB);
    const { issue } = await service.createPullRequest({
      repoId: REPO_ID,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
      title: "carrier pull",
      content: "review please @alice",
      posterId: AUTHOR_ID,
      now: T0,
    });
    expect(await getIssueMentionIds(env.DB, issue.id)).toEqual([ALICE_ID]);
  });

  it("content without mentions writes zero carrier rows", async () => {
    const service = new IssuesService(env.DB);
    const issue = await service.createIssue({
      repoId: REPO_ID,
      title: "plain",
      content: "nothing to see",
      posterId: AUTHOR_ID,
      now: T0,
    });
    expect(await getIssueMentionIds(env.DB, issue.id)).toEqual([]);
  });

  it("no un-mention: a later mention-free comment leaves the flag sticky (the pin writes true only)", async () => {
    const service = new IssuesService(env.DB);
    const issue = await service.createIssue({
      repoId: REPO_ID,
      title: "sticky",
      content: "first @alice",
      posterId: AUTHOR_ID,
      now: T0,
    });
    await service.addComment({ issueId: issue.id, posterId: AUTHOR_ID, content: "mention dropped", now: T0 });
    await service.addComment({ issueId: issue.id, posterId: AUTHOR_ID, content: "and again", now: T0 });
    expect(await getIssueMentionIds(env.DB, issue.id)).toEqual([ALICE_ID]);
  });
});

// ---------------------------------------------------------------------------
// The derived mailbox's mention arm (routes/notifications.ts recipientExpr)
// ---------------------------------------------------------------------------

function userPayload(id: number, username: string): User {
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
    is_admin: false,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: T0.toISOString(),
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

function resolver(): AuthResolver {
  return {
    resolveToken: (token): Promise<User | null> => {
      if (token === "alice-token") return Promise.resolve(userPayload(ALICE_ID, "alice"));
      if (token === "bystander-token") return Promise.resolve(userPayload(BYSTANDER_ID, "bystander"));
      return Promise.resolve(null);
    },
  };
}

interface Thread {
  id: number;
  unread: boolean;
}

describe("the notifications mention arm — a mentioned user reads the thread (mail_issue.go:99-105)", () => {
  function mentionedApp(): (path: string, init?: RequestInit) => Promise<Response> {
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerNotificationsRoutes(app, createTokenAuthMiddleware(resolver()));
    return async (path: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
  }

  const authed = (token: string): RequestInit => ({ headers: { Authorization: `token ${token}` } });

  it("the carrier row alone qualifies the mentioned user's mailbox — no watch, no subscription, no comment", async () => {
    const service = new IssuesService(env.DB);
    const issue = await service.createIssue({
      repoId: REPO_ID,
      title: "for alice",
      content: "heads up @alice",
      posterId: AUTHOR_ID,
      now: T0,
    });
    const send = mentionedApp();
    const response = await send("/notifications", authed("alice-token"));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("1");
    const threads = await response.json<Thread[]>();
    expect(threads.map((thread) => thread.id)).toEqual([issue.id]);
    expect(threads[0]?.unread).toBe(true);
  });

  it("a bystander with no carrier row and no relationship sees nothing", async () => {
    const service = new IssuesService(env.DB);
    await service.createIssue({
      repoId: REPO_ID,
      title: "not for you",
      content: "heads up @alice",
      posterId: AUTHOR_ID,
      now: T0,
    });
    const send = mentionedApp();
    const response = await send("/notifications", authed("bystander-token"));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Total-Count")).toBe("0");
  });

  it("the arm survives the whole-family wipe: no issue_user rows, no threads from mentions", async () => {
    const service = new IssuesService(env.DB);
    const issue = await service.createIssue({
      repoId: REPO_ID,
      title: "for alice",
      content: "heads up @alice",
      posterId: AUTHOR_ID,
      now: T0,
    });
    await drizzle(env.DB).delete(issueUsers).where(eq(issueUsers.issueId, issue.id));
    const send = mentionedApp();
    const response = await send("/notifications", authed("alice-token"));
    expect(response.headers.get("X-Total-Count")).toBe("0");
  });
});

// The suite's own smoke: the fixture repo's counters reset cleanly per test
// (the createIssue counter bootstrap rides repo_counters).
it("fixtures wipe between tests — issue_user has no stray rows at suite start", async () => {
  expect(await drizzle(env.DB).select().from(issueUsers).all()).toEqual([]);
  expect(await drizzle(env.DB).select().from(pullRequests).all()).toEqual([]);
  expect(await drizzle(env.DB).select().from(issues).all()).toEqual([]);
  expect(await drizzle(env.DB).select().from(repoCounters).all()).toEqual([]);
});
