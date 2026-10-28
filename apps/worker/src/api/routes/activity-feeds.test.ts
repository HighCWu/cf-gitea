/**
 * Activity feeds (specs/activity-feeds.md): the three /activities/feeds
 * reads over the new `action` table, and the red→green write path through
 * the landed event emitters (services/repo-events.ts + services/issue-events.ts
 * — the SPEC §3.2 insert hooks). Standalone mounts per the tier2-extras
 * convention; the routes ARE registered in router.ts by the orchestrator
 * after this batch.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";

import {
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  STUB_USER,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerActivityFeedRoutes } from "./activity-feeds";
import { emitRepoEvent, type RepoEventEmission } from "../../services/repo-events";
import { emitIssueEvent, type IssueEventEmission } from "../../services/issue-events";
import {
  ActionType,
  getFeedRows,
  opTypeName,
  recordAction,
  renderFeedItems,
  type Activity,
  type FeedQueryOptions,
} from "../services/activity-feeds";
import { toApiComment } from "../services/issues";
import {
  apiUserFromRow,
  findRepositoryById,
  toApiRepository,
  type RepositoryWithOwner,
  type Viewer,
} from "../services/repository";
import { type Comment } from "../models/issue";
import { comments, issues, users } from "../../db/schema";

const NOW = new Date("2026-02-03T04:05:06Z");
const REPO_ID = "7300";
const ORG_REPO_ID = "7301";
const PRIVATE_REPO_ID = "7302";

const TOKEN = "stub-token"; // the seed user (id 1)
const TOKEN_NEIGHBOR = "neighbor-token";
const TOKEN_ADMIN = "admin-token";

let neighborId = 0;
let adminId = 0;
let orgId = 0;

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return Promise.resolve(STUB_USER);
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

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void, fetchEnv: ApiEnv["Bindings"] = env) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), fetchEnv));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const feedsApp = familyApp((app) =>
  registerActivityFeedRoutes(
    app,
    createTokenAuthMiddleware(resolver()),
    createOptionalTokenAuthMiddleware(resolver()),
  ),
);

/** The hono-shaped request source the emitters take (no queue binding). */
const emitterRequest = { env, executionCtx: { waitUntil: () => {} } };

/** One issue-family emission with the §2.7 payload shape the routes render. */
async function emitIssueOpened(options: {
  repoId: string;
  isPrivate: boolean;
  senderId: number;
  number?: number;
  title?: string;
  at?: Date;
}): Promise<void> {
  const emission: IssueEventEmission = {
    repoId: options.repoId,
    ownerId: null,
    eventType: "issues",
    payload: {
      action: "opened",
      number: options.number ?? 1,
      issue: { number: options.number ?? 1, title: options.title ?? "T", pull_request: null },
      repository: { private: options.isPrivate },
      sender: { id: options.senderId },
    },
  };
  await emitIssueEvent(emitterRequest, emission);
}

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  const { applyRepoExtrasDdl } = await import("../testing/repo-ddl");
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  for (const table of [
    "action",
    "comments",
    "issues",
    "repo_watchers",
    "repo_collaborators",
    "org_members",
    "team_members",
    "team_repo_access",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  // The repo owner — repositories join their owner on username_lower =
  // owner_namespace, so the namespace needs a live user row.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, created_at) VALUES (2, 'alice', 'alice', 0)",
  ).run();
  const neighbor = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, created_at) VALUES ('neighbor', 'neighbor', 0)",
  ).run();
  neighborId = neighbor.meta.last_row_id;
  const admin = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, is_admin, created_at) VALUES ('root', 'root', 1, 0)",
  ).run();
  adminId = admin.meta.last_row_id;
  const org = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, type, num_members, created_at) VALUES ('myorg', 'myorg', 'org', 1, 0)",
  ).run();
  orgId = org.meta.last_row_id;

  for (const [id, namespace, ownerId, visibility, slug] of [
    [REPO_ID, "alice", 2, "public", "repo"],
    [ORG_REPO_ID, "myorg", orgId, "public", "orgrepo"],
    [PRIVATE_REPO_ID, "alice", 2, "private", "privrepo"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())",
    )
      .bind(id, `r_${id}`, namespace, ownerId, slug, visibility)
      .run();
  }
});

describe("activity feeds — write path through the emitters", () => {
  it("records create_issue rows with the NotifyWatchers fan-out (original + org + watchers)", async () => {
    await env.DB.prepare("INSERT INTO repo_watchers (repo_id, user_id) VALUES (?, ?)").bind(REPO_ID, neighborId).run();
    await emitRepoEvent(emitterRequest, {
      repoId: ORG_REPO_ID,
      ownerId: orgId,
      eventType: "repository",
      payload: { action: "created", repository: { private: false }, sender: { id: 1 } },
    } satisfies RepoEventEmission);
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1, title: "Feed me" });

    const rows = await env.DB.prepare("SELECT user_id, op_type, act_user_id, repo_id, content FROM action ORDER BY id").all();
    // create_repo: original(1) + org row; create_issue: original(1) + watcher row.
    expect(rows.results).toEqual([
      { user_id: 1, op_type: ActionType.CreateRepo, act_user_id: 1, repo_id: ORG_REPO_ID, content: "" },
      { user_id: orgId, op_type: ActionType.CreateRepo, act_user_id: 1, repo_id: ORG_REPO_ID, content: "" },
      { user_id: 1, op_type: ActionType.CreateIssue, act_user_id: 1, repo_id: REPO_ID, content: "1|Feed me" },
      { user_id: neighborId, op_type: ActionType.CreateIssue, act_user_id: 1, repo_id: REPO_ID, content: "1|Feed me" },
    ]);
  });

  it("maps rename_repo with the old name as content", async () => {
    await emitRepoEvent(emitterRequest, {
      repoId: REPO_ID,
      ownerId: 1,
      eventType: "repository",
      payload: {
        action: "renamed",
        repository: { private: false },
        sender: { id: 1 },
        changes: { name: { from: "old-name" } },
      },
    } satisfies RepoEventEmission);
    const row = await env.DB.prepare("SELECT op_type, content FROM action").first();
    expect(row).toEqual({ op_type: ActionType.RenameRepo, content: "old-name" });
  });

  it("writes no row for repo deletion, comment edits, or label/milestone events", async () => {
    await emitRepoEvent(emitterRequest, {
      repoId: REPO_ID,
      ownerId: 1,
      eventType: "repository",
      payload: { action: "deleted", repository: { private: false }, sender: { id: 1 } },
    } satisfies RepoEventEmission);
    await emitIssueEvent(emitterRequest, {
      repoId: REPO_ID,
      ownerId: 1,
      eventType: "issue_comment",
      payload: {
        action: "edited",
        issue: { number: 1, title: "T", pull_request: null },
        comment: { id: 9, body: "later" },
        repository: { private: false },
        sender: { id: 1 },
      },
    } satisfies IssueEventEmission);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM action").first())?.n).toBe(0);
  });
});

describe("activity feeds — repoListActivityFeeds", () => {
  it("answers the plain-array page with the original rows only", async () => {
    await env.DB.prepare("INSERT INTO repo_watchers (repo_id, user_id) VALUES (?, ?)").bind(REPO_ID, neighborId).run();
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1, title: "Feed me" });
    const res = await feedsApp(`/repos/alice/repo/activities/feeds`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      user_id: 1,
      op_type: "create_issue",
      act_user_id: 1,
      repo_id: 7300,
      content: "1|Feed me",
      is_private: false,
      comment_id: 0,
      ref_name: "",
    });
    expect(typeof body[0]?.created).toBe("string");
    expect((body[0]?.act_user as Record<string, unknown>)?.login).toBe("cf-gitea-stub");
    expect((body[0]?.repo as Record<string, unknown>)?.full_name).toBe("alice/repo");
  });

  it("404s the anti-enumeration miss for invisible repos", async () => {
    await emitIssueOpened({ repoId: PRIVATE_REPO_ID, isPrivate: true, senderId: 1 });
    const res = await feedsApp(`/repos/alice/privrepo/activities/feeds`);
    expect(res.status).toBe(404);
    const body = await res.json<Record<string, unknown>>();
    expect(body.message).toBe("not found");
  });
});

describe("activity feeds — userListActivityFeeds", () => {
  it("shows the watcher fan-out rows in the watcher's own feed", async () => {
    await env.DB.prepare("INSERT INTO repo_watchers (repo_id, user_id) VALUES (?, ?)").bind(REPO_ID, neighborId).run();
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1 });
    const res = await feedsApp(`/users/neighbor/activities/feeds`, authed({}, TOKEN_NEIGHBOR));
    expect(res.status).toBe(200);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ user_id: neighborId, act_user_id: 1, op_type: "create_issue" });
  });

  it("honors only-performed-by through the FormBool rule", async () => {
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1 });
    const res = await feedsApp(`/users/cf-gitea-stub/activities/feeds?only-performed-by=true`, authed({}));
    expect(res.status).toBe(200);
    expect(await res.json<unknown[]>()).toHaveLength(1);
    const resOff = await feedsApp(`/users/cf-gitea-stub/activities/feeds?only-performed-by=nope`);
    expect((await resOff.json<unknown[]>()).length).toBe(1); // FormBool("nope") = false, but the only rows are self-performed anyway
  });

  it("404s invisible subjects and answers private-visibility subjects only for self/admin", async () => {
    await env.DB.prepare("UPDATE users SET visibility = 'private' WHERE id = ?").bind(neighborId).run();
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1 });
    const stranger = await feedsApp(`/users/neighbor/activities/feeds`);
    expect(stranger.status).toBe(404);
    const self = await feedsApp(`/users/neighbor/activities/feeds`, authed({}, TOKEN_NEIGHBOR));
    expect(self.status).toBe(200);
    const admin = await feedsApp(`/users/neighbor/activities/feeds`, authed({}, TOKEN_ADMIN));
    expect(admin.status).toBe(200);
  });

  it("hides private-repo actions behind IncludePrivate", async () => {
    await emitIssueOpened({ repoId: PRIVATE_REPO_ID, isPrivate: true, senderId: 1 });
    const anonymous = await feedsApp(`/users/cf-gitea-stub/activities/feeds`);
    expect(await anonymous.json<unknown[]>()).toHaveLength(0);
    const self = await feedsApp(`/users/cf-gitea-stub/activities/feeds`, authed({}));
    expect(await self.json<unknown[]>()).toHaveLength(1); // self ⇒ IncludePrivate
  });
});

describe("activity feeds — orgListActivityFeeds", () => {
  it("serves the org receiver rows to anonymous callers", async () => {
    await emitRepoEvent(emitterRequest, {
      repoId: ORG_REPO_ID,
      ownerId: orgId,
      eventType: "repository",
      payload: { action: "created", repository: { private: false }, sender: { id: 1 } },
    } satisfies RepoEventEmission);
    const res = await feedsApp(`/orgs/myorg/activities/feeds`);
    expect(res.status).toBe(200);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1); // the org row only (original row is user 1's)
    expect(body[0]).toMatchObject({ user_id: orgId, op_type: "create_repo" });
  });

  it("404s non-org subjects and unknown orgs", async () => {
    expect((await feedsApp(`/users/cf-gitea-stub/x/activities/feeds`)).status).toBe(404);
    expect((await feedsApp(`/orgs/cf-gitea-stub/activities/feeds`)).status).toBe(404); // a user, not an org
    expect((await feedsApp(`/orgs/ghost/activities/feeds`)).status).toBe(404);
  });
});

describe("activity feeds — comments and reviews", () => {
  it("renders comment_issue with the embedded comment object", async () => {
    const issue = await env.DB.prepare(
      'INSERT INTO issues (repo_id, "index", poster_id, title) VALUES (?, 1, 1, \'T\')',
    )
      .bind(REPO_ID)
      .run();
    const comment = await env.DB.prepare(
      "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, 1, ?, 'hi', unixepoch())",
    )
      .bind(issue.meta.last_row_id)
      .run();
    await emitIssueEvent(emitterRequest, {
      repoId: REPO_ID,
      ownerId: 1,
      eventType: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 1, title: "T", pull_request: null },
        comment: { id: comment.meta.last_row_id, body: "hi" },
        repository: { private: false },
        sender: { id: 1 },
      },
    } satisfies IssueEventEmission);
    const res = await feedsApp(`/repos/alice/repo/activities/feeds`);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ op_type: "comment_issue", content: "1|hi" });
    expect((body[0]?.comment as Record<string, unknown>)?.body).toBe("hi");
  });

  it("maps submitted reviews to approve/reject/comment_pull", async () => {
    for (const [eventType, , content] of [
      ["pull_request_review_approved", "approve_pull_request", "7|lgtm"],
      ["pull_request_review_rejected", "reject_pull_request", "8|needs work"],
      ["pull_request_review_comment", "comment_pull", "9|nit"],
    ] as const) {
      await emitIssueEvent(emitterRequest, {
        repoId: REPO_ID,
        ownerId: 1,
        eventType,
        payload: {
          action: "reviewed",
          number: Number(content.split("|")[0]),
          pull_request: {},
          repository: { private: false },
          sender: { id: 1 },
          review: { type: eventType, content: content.split("|")[1] },
        },
      } satisfies IssueEventEmission);
    }
    const res = await feedsApp(`/repos/alice/repo/activities/feeds`);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((item) => [item.op_type, item.content])).toEqual([
      ["comment_pull", "9|nit"],
      ["reject_pull_request", "8|needs work"],
      ["approve_pull_request", "7|lgtm"],
    ]);
  });
});

describe("activity feeds — date window and pagination", () => {
  beforeEach(async () => {
    for (const offset of [0, 1, 2]) {
      await recordAction(env.DB, {
        actUserId: 1,
        repoId: REPO_ID,
        opType: ActionType.CreateIssue,
        isPrivate: false,
        content: `${offset + 1}|t`,
        createdAt: new Date(NOW.getTime() + offset * 1000),
      });
    }
  });

  it("filters by the UTC date window", async () => {
    const hit = await feedsApp(`/repos/alice/repo/activities/feeds?date=2026-02-03`);
    expect((await hit.json<unknown[]>()).length).toBe(3);
    const miss = await feedsApp(`/repos/alice/repo/activities/feeds?date=2026-02-04`);
    expect(await miss.json<unknown[]>()).toHaveLength(0);
    const junk = await feedsApp(`/repos/alice/repo/activities/feeds?date=not-a-date`);
    expect((await junk.json<unknown[]>()).length).toBe(3); // unparsable skips the filter (upstream parity)
  });

  it("paginates with the landed clamping and list headers", async () => {
    const res = await feedsApp(`/repos/alice/repo/activities/feeds?page=1&limit=2`);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const link = res.headers.get("Link") ?? "";
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(2);
    // created_unix DESC: the newest first.
    expect(body[0]?.content).toBe("3|t");
  });
});

describe("activity feeds — repo feeds read original rows only", () => {
  it("excludes the receiver fan-out copies", async () => {
    await env.DB.prepare("INSERT INTO repo_watchers (repo_id, user_id) VALUES (?, ?)").bind(REPO_ID, neighborId).run();
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1 });
    const res = await feedsApp(`/repos/alice/repo/activities/feeds`);
    // Two action rows exist for this action (original + watcher); the repo
    // feed dedups to user_id = act_user_id.
    expect((await res.json<unknown[]>()).length).toBe(1);
  });
});

describe("activity feeds — the is_deleted read filter (GetFeeds parity pin)", () => {
  // Upstream's feed reads filter is_deleted=false in BOTH branches of
  // GetFeeds (models/activities/action_list.go:222-224 fast path,
  // models/activities/action.go:539-541 ActivityQueryCondition; only the
  // heatmap passes IncludeDeleted: true, user_heatmap.go:55). Nothing in
  // upstream sets the flag (repo delete hard-deletes the rows,
  // services/repository/delete.go:155-157), and ours likewise never writes
  // it true — the filter is the parity arm, pinned here against regressions.

  it("hides is_deleted rows from the repo and user feeds (total included)", async () => {
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1 });
    await env.DB.prepare("UPDATE action SET is_deleted = 1 WHERE repo_id = ?").bind(REPO_ID).run();

    const repoFeed = await feedsApp(`/repos/alice/repo/activities/feeds`);
    expect(repoFeed.status).toBe(200);
    expect(repoFeed.headers.get("X-Total-Count")).toBe("0");
    expect(await repoFeed.json<unknown[]>()).toHaveLength(0);

    const userFeed = await feedsApp(`/users/cf-gitea-stub/activities/feeds`, authed({}));
    expect(userFeed.status).toBe(200);
    expect(userFeed.headers.get("X-Total-Count")).toBe("0");
    expect(await userFeed.json<unknown[]>()).toHaveLength(0);
  });

  it("keeps is_deleted=false rows visible (the filter is the only arm)", async () => {
    await emitIssueOpened({ repoId: REPO_ID, isPrivate: false, senderId: 1 });
    const res = await feedsApp(`/repos/alice/repo/activities/feeds`);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect(await res.json<unknown[]>()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Query-shape witness (docs/research/query-shape-audit.md A8) — the feed
// render resolved each DISTINCT repo through findRepositoryById and each
// live comment's poster through toApiComment's per-row toPoster (R + C
// selects per page on top of the fixed prefix). The page now batches both:
// ONE findRepositoriesByIds join for the repo pairs and ONE
// prefetchCommentPosters inArray for the posters (upstream
// comments.LoadPosters is the same fix). The per-row helpers stay intact —
// metered side by side below on the SAME rows and viewer, the issues.test.ts
// A2/A5/A7 witness pattern.
// ---------------------------------------------------------------------------

/** prepare()-counting D1 wrapper: every drizzle statement enters through one
 *  prepare() call. Scoped to the requests that pass the returned env. */
function countedD1(): { db: D1Database; count: () => number } {
  let statements = 0;
  const wrapper = Object.create(env.DB) as D1Database;
  wrapper.prepare = (query: string) => {
    statements += 1;
    return env.DB.prepare(query);
  };
  return { db: wrapper, count: () => statements };
}

describe("activity feeds query-shape witness (query-shape-audit A8)", () => {
  it("renders the page with a constant statement count, deep-equal to the per-row fallback render", async () => {
    // Every render arm on ONE page: two live repos (R=2 distinct), a
    // public repo whose owner row is MISSING (passes the anonymous SQL
    // visibility filter, then SKIPS at render — the join-miss arm), two
    // act users (one arriving via the watcher fan-out copy), three live
    // comments across two distinct posters (the third dedupes), and one
    // dangling comment id (renders WITHOUT the comment object).
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, created_at) VALUES ('7303', 'r_7303', 'ghost', 2, 'ghostrepo', 'public', unixepoch())",
    ).run(); // owner_namespace has NO users row — the pair join misses
    await env.DB.prepare("INSERT INTO repo_watchers (repo_id, user_id) VALUES (?, ?)").bind(ORG_REPO_ID, 1).run();
    await recordAction(env.DB, { actUserId: 1, repoId: REPO_ID, opType: ActionType.CreateIssue, isPrivate: false, content: "1|one" });
    await recordAction(env.DB, { actUserId: neighborId, repoId: ORG_REPO_ID, opType: ActionType.CreateIssue, isPrivate: false, content: "2|two" });
    const issueInsert = await env.DB.prepare(
      'INSERT INTO issues (repo_id, "index", poster_id, title) VALUES (?, 1, 1, \'T\')',
    )
      .bind(REPO_ID)
      .run();
    const issueId = issueInsert.meta.last_row_id;
    const c1 = await env.DB.prepare(
      "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, 1, ?, 'hi one', unixepoch())",
    )
      .bind(issueId)
      .run().then((r) => r.meta.last_row_id);
    const c2 = await env.DB.prepare(
      "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, ?, ?, 'hi two', unixepoch())",
    )
      .bind(neighborId, issueId)
      .run().then((r) => r.meta.last_row_id);
    const c3 = await env.DB.prepare(
      "INSERT INTO comments (type, poster_id, issue_id, content, created_unix) VALUES (0, 1, ?, 'hi three', unixepoch())",
    )
      .bind(issueId)
      .run().then((r) => r.meta.last_row_id);
    await recordAction(env.DB, { actUserId: 1, repoId: REPO_ID, opType: ActionType.CommentIssue, isPrivate: false, content: "1|hi one", commentId: c1 });
    await recordAction(env.DB, { actUserId: 1, repoId: REPO_ID, opType: ActionType.CommentIssue, isPrivate: false, content: "1|hi two", commentId: c2 });
    await recordAction(env.DB, { actUserId: 1, repoId: REPO_ID, opType: ActionType.CommentIssue, isPrivate: false, content: "1|hi three", commentId: c3 }); // poster dedupes with c1
    await recordAction(env.DB, { actUserId: 1, repoId: REPO_ID, opType: ActionType.CommentIssue, isPrivate: false, content: "1|ghost", commentId: 999999 }); // dead comment arm
    await recordAction(env.DB, { actUserId: 1, repoId: "7303", opType: ActionType.CreateIssue, isPrivate: false, content: "1|gone" }); // join-miss arm

    // (a) The route, metered end to end: 1 subject lookup + 2 (count + page)
    // + 5 batched render reads (act users, repo pairs, comments, issues,
    // posters) = 8 — page-INDEPENDENT. The pre-fix shape paid
    // 1 + 2 + 1 + R(3) + 2 + C(3) = 12 at this N; the 3 per-row repo pairs
    // and 3 per-comment posters alone would break the bound.
    const meter = countedD1();
    const meteredApp = familyApp((app) =>
      registerActivityFeedRoutes(
        app,
        createTokenAuthMiddleware(resolver()),
        createOptionalTokenAuthMiddleware(resolver()),
      ), { ...env, DB: meter.db });
    const res = await meteredApp(`/users/cf-gitea-stub/activities/feeds`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("7"); // total counts ALL matched rows...
    const body = await res.json<Array<Record<string, unknown> & { act_user_id: number; comment_id: number; comment?: unknown }>>();
    expect(body).toHaveLength(6); // ...the join-miss repo row is skipped at render
    const routeCount = meter.count();
    expect(routeCount).toBeLessThanOrEqual(8);
    expect(routeCount).toBeLessThan(13); // the pre-fix route shape at this N

    // Empty-skip discipline: an empty page skips every render arm — exactly
    // the fixed prefix (subject lookup + count + page = 3).
    const emptyMeter = countedD1();
    const emptyApp = familyApp((app) =>
      registerActivityFeedRoutes(
        app,
        createTokenAuthMiddleware(resolver()),
        createOptionalTokenAuthMiddleware(resolver()),
      ), { ...env, DB: emptyMeter.db });
    const emptyRes = await emptyApp(`/users/cf-gitea-stub/activities/feeds?date=1999-01-01`);
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json<unknown[]>()).toEqual([]);
    expect(emptyMeter.count()).toBeLessThanOrEqual(4);

    // The same rows the route fetched, for the side-by-side arms below.
    const viewer: Viewer = { origin: "https://example.com", requester: null };
    const opts: FeedQueryOptions = {
      kind: "user",
      requested: { id: STUB_USER.id ?? 1 }, // the seeded stub user row (id 1)
      actor: null, // the route ran anonymous — the same visibility window
      includePrivate: false,
      onlyPerformedBy: false,
      page: 1,
      limit: 30,
    };
    const { rows } = await getFeedRows(env.DB, opts);
    expect(rows).toHaveLength(7);

    // (b) The per-row FALLBACK — the pre-fix render body (findRepositoryById
    // per distinct repo + toApiComment's per-row poster select), metered on
    // the same rows and viewer: 1 act-user batch + R×repo (R=3, the
    // join-miss id included) + 2 (comments + issues) + C×poster (C=3) = 9.
    const fallbackMeter = countedD1();
    const fdb = drizzle(fallbackMeter.db);
    const actUserRows = await fdb
      .select()
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((row) => row.actUserId))]))
      .all();
    const actUsersById = new Map(actUserRows.map((row) => [row.id, row]));
    const pairsById = new Map<string, RepositoryWithOwner>();
    for (const repoId of [...new Set(rows.map((row) => row.repoId))]) {
      const pair = await findRepositoryById(fallbackMeter.db, repoId);
      if (pair !== null) pairsById.set(repoId, pair);
    }
    const commentRows = await fdb
      .select()
      .from(comments)
      .where(inArray(comments.id, [...new Set(rows.filter((row) => row.commentId !== 0).map((row) => row.commentId))]))
      .all();
    const issueRows = await fdb
      .select()
      .from(issues)
      .where(inArray(issues.id, [...new Set(commentRows.map((row) => row.issueId))]))
      .all();
    const issuesById = new Map(issueRows.map((row) => [row.id, row]));
    const commentRenders = new Map<number, { comment: Comment; issueId: number }>();
    for (const commentRow of commentRows) {
      const issueRow = issuesById.get(commentRow.issueId);
      const pair = issueRow === undefined ? undefined : pairsById.get(issueRow.repoId);
      if (issueRow === undefined || pair === undefined) continue;
      commentRenders.set(commentRow.id, {
        comment: await toApiComment(fallbackMeter.db, viewer, pair, issueRow, commentRow),
        issueId: issueRow.id,
      });
    }
    const numericRepoId = (id: string): number => {
      const parsed = Number(id);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
    };
    const perRow: Activity[] = [];
    for (const row of rows) {
      const actUser = actUsersById.get(row.actUserId);
      const pair = pairsById.get(row.repoId);
      if (actUser === undefined || pair === undefined) continue;
      const renderedComment = commentRenders.get(row.commentId);
      perRow.push({
        id: row.id,
        user_id: row.userId,
        op_type: opTypeName(row.opType),
        act_user_id: row.actUserId,
        act_user: apiUserFromRow(actUser, viewer),
        repo_id: numericRepoId(row.repoId),
        repo: toApiRepository(viewer, pair),
        comment_id: row.commentId,
        ...(renderedComment === undefined ? {} : { comment: renderedComment.comment }),
        ref_name: row.refName,
        is_private: row.isPrivate,
        content: row.content,
        created: row.createdAt === null ? "0001-01-01T00:00:00Z" : row.createdAt.toISOString(),
      });
    }
    const fallbackCount = fallbackMeter.count();
    expect(fallbackCount).toBeGreaterThanOrEqual(6); // the per-row repos + posters alone (R=3 + C=3)

    // (c) The BATCHED render, metered on the same rows and viewer: 5 (act
    // users + repo pairs + comments + issues + posters) — page-INDEPENDENT
    // and strictly under the fallback at this N.
    const renderMeter = countedD1();
    const rendered = await renderFeedItems(renderMeter.db, viewer, rows);
    const renderCount = renderMeter.count();
    expect(renderCount).toBeLessThanOrEqual(5);
    expect(renderCount).toBeLessThan(fallbackCount); // 5 vs 9 at this N

    // Contract discipline: the batched render AND the route body are
    // deep-equal to the per-row fallback render — covers both act users,
    // both live repos, the poster dedupe, the dangling comment (no comment
    // object) and the skipped join-miss repo in one sweep.
    expect(rendered).toEqual(perRow);
    expect(body).toEqual(perRow);
    expect(new Set(body.map((item) => item.act_user_id))).toEqual(new Set([1, neighborId]));
    expect(body.filter((item) => item.comment !== undefined)).toHaveLength(3);
    expect(body.find((item) => item.comment_id === 999999)?.comment).toBeUndefined();
  });
});
