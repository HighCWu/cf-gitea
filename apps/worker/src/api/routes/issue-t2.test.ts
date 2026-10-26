/**
 * The reaction CREATE blocked arms on real D1 — the focused standalone mount
 * for the blocks-enforcement sweep (the full issue-t2 family lives in
 * src/api/tier2-extras.test.ts). Pins CreateIssueReaction's check
 * (services/issue/reaction.go:20-21: `IsUserBlockedBy(doer, issue.PosterID,
 * issue.Repo.OwnerID)` → ErrBlockedUser) and CreateCommentReaction's
 * (:41-42: the same pair PLUS the comment poster) surfaced through the API
 * handlers' ErrBlockedUser unwrap as 403 "user is blocked"
 * (routers/api/v1/repo/issue_reaction.go:202, 417), positioned BEFORE the
 * allowed-content check exactly like upstream (the probe is
 * CreateIssueReaction's first gate, ahead of CreateReaction's
 * ErrForbiddenIssueReaction), with the IsUserBlockedBy site-admin bypass
 * (models/user/block.go:42-44). The DELETE arms carry no upstream probe.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { comments, reactions, repositories, userBlocking, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerIssueT2Routes } from "./issue-t2";

const ERROR_URL = "https://example.com/api/swagger";

/** Seeded D1 users the resolver authenticates as (`token u<id>`). */
const seededUsers = new Map<number, { id: number; username: string; isAdmin: boolean }>();

async function seedUser(username: string, options: { isAdmin?: boolean } = {}): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin: options.isAdmin ?? false });
  return { id: user.id, username: user.username };
}

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

const makeApp = () => {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerIssueT2Routes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  seededUsers.clear();
  for (const table of ["reactions", "issue_subscriptions", "issue_pins", "comments", "issues", "repo_counters", "user_blocking", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("POST …/reactions: the CreateIssueReaction/CreateCommentReaction blocked arms", () => {
  /** The recluse-owned repo with recluse's issue #1 and a comment by
   *  `speaker`; `actor` is the reacting doer. */
  async function seedIssueFixture(): Promise<{ ownerId: number; posterId: number; speakerId: number; actorId: number; issueId: number; issueIndex: number; commentId: number }> {
    const owner = await seedUser("recluse");
    const speaker = await seedUser("speaker");
    const actor = await seedUser("actor");
    await drizzle(env.DB).insert(repositories).values({
      id: "7304",
      storageKey: "r_7304",
      ownerNamespace: "recluse",
      ownerId: owner.id,
      slug: "repo",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date("2026-02-03T04:05:06Z"),
    });
    const issue = await new IssuesService(env.DB).createIssue({ repoId: "7304", title: "blocked reactions", posterId: owner.id });
    const comment = await drizzle(env.DB)
      .insert(comments)
      .values({
        type: CommentType.Comment,
        posterId: speaker.id,
        issueId: issue.id,
        content: "hello",
        createdAt: new Date("2026-02-04T00:00:00Z"),
        updatedAt: new Date("2026-02-04T00:00:00Z"),
      })
      .returning({ id: comments.id })
      .all();
    return {
      ownerId: owner.id,
      posterId: owner.id,
      speakerId: speaker.id,
      actorId: actor.id,
      issueId: Number(issue.id),
      issueIndex: issue.index,
      commentId: comment[0]!.id,
    };
  }

  const block = (blockerId: number, blockeeId: number) =>
    drizzle(env.DB).insert(userBlocking).values({ blockerId, blockeeId, note: "", createdAt: new Date() });

  const postIssueReaction = (actorId: number, content: string) =>
    makeApp()(`/repos/recluse/repo/issues/1/reactions`, {
      method: "POST",
      headers: { Authorization: `token u${actorId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

  const postCommentReaction = (actorId: number, commentId: number, content: string) =>
    makeApp()(`/repos/recluse/repo/issues/comments/${commentId}/reactions`, {
      method: "POST",
      headers: { Authorization: `token u${actorId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

  it("403s \"user is blocked\" when the doer is blocked by the issue poster (reaction.go:20-21 via issue_reaction.go:202)", async () => {
    const f = await seedIssueFixture();
    await block(f.posterId, f.actorId);
    const res = await postIssueReaction(f.actorId, "heart");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await drizzle(env.DB).select().from(reactions).all()).toHaveLength(0);
  });

  it("403s when the doer is blocked by the repo owner (the probe's second id, reaction.go:21)", async () => {
    const f = await seedIssueFixture();
    await block(f.ownerId, f.actorId);
    const res = await postIssueReaction(f.actorId, "heart");
    expect(res.status).toBe(403);
    expect(await drizzle(env.DB).select().from(reactions).all()).toHaveLength(0);
  });

  it("the probe precedes the allowed-content check — a blocked doer with an invalid content still answers \"user is blocked\" (upstream's probe-before-CreateReaction order)", async () => {
    const f = await seedIssueFixture();
    await block(f.posterId, f.actorId);
    const res = await postIssueReaction(f.actorId, "not-an-emoji");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
  });

  it("201s once no blocking row relates the pair (the arm lifts with the block)", async () => {
    const f = await seedIssueFixture();
    await block(f.posterId, f.actorId);
    await env.DB.prepare("DELETE FROM user_blocking").run();
    const res = await postIssueReaction(f.actorId, "heart");
    expect(res.status).toBe(201);
    expect(await drizzle(env.DB).select().from(reactions).all()).toHaveLength(1);
  });

  it("the comment arm includes the COMMENT poster in the blocked set (reaction.go:41-42 via issue_reaction.go:417)", async () => {
    const f = await seedIssueFixture();
    await block(f.speakerId, f.actorId);
    const res = await postCommentReaction(f.actorId, f.commentId, "heart");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await drizzle(env.DB).select().from(reactions).all()).toHaveLength(0);
  });

  it("a site-admin doer bypasses the comment arm (IsUserBlockedBy's blockee.IsAdmin short-circuit)", async () => {
    const f = await seedIssueFixture();
    const admin = await seedUser("root", { isAdmin: true });
    await block(f.posterId, admin.id);
    await block(f.speakerId, admin.id);
    const res = await postCommentReaction(admin.id, f.commentId, "heart");
    expect(res.status).toBe(201);
  });

  it("DELETE carries no upstream probe — an unreact stays 204 while blocked", async () => {
    const f = await seedIssueFixture();
    await drizzle(env.DB).insert(reactions).values({ userId: f.actorId, issueId: f.issueId, commentId: 0, type: "heart", createdAt: new Date("2026-02-05T00:00:00Z") });
    await block(f.posterId, f.actorId);
    const res = await makeApp()(`/repos/recluse/repo/issues/1/reactions`, {
      method: "DELETE",
      headers: { Authorization: `token u${f.actorId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "heart" }),
    });
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(reactions).all()).toHaveLength(0);
  });
});
