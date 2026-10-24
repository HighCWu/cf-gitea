/**
 * Tier-1 issue-block routes on real D1 (SPEC-0004 §2.4 rows issueListIssues …
 * issueSearchIssues; behavior per SPEC-0005 §2.2). Pins the upstream gotchas:
 * the POST→201 / PATCH→201 quirks, the per-repo issue index vs GLOBAL comment
 * id id spaces, the 204-on-system-comment GET, the labels verb semantics
 * (POST=add / PUT=replace / DELETE=clear), the mixed-type timeline stream,
 * the RFC3339 since/before 422s, the CAS 409 on stale content_version, the
 * §4.12 delete cascade (index never reused), and the webhook triggers
 * (issues opened/edited/closed/reopened + issue_comment created via
 * emitWebhookDeliveries — rows land inline, the Queue enqueue is the
 * executionCtx-guarded no-op under app.request).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, issues, labels, milestones, repoCounters, repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { IssuesService } from "../issues/service";
import { createApiRouter } from "./router";
import contract from "../compat/contract/v1-swagger.generated.json";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "pull_requests",
    "comments",
    "issue_labels",
    "issues",
    "milestones",
    "labels",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity is STUB_USER (id 1); D1 autoincrement starts at
  // 2 after a reset, so pin an explicit id-1 row for it — every stub-authored
  // item then renders the cf-gitea-stub poster naturally.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const ISSUE_FIELDS = Object.keys(contract.definitions.Issue.properties).sort();
const COMMENT_FIELDS = Object.keys(contract.definitions.Comment.properties).sort();
const TIMELINE_FIELDS = Object.keys(contract.definitions.TimelineComment.properties).sort();

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const jsonHeaders = { "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 700;

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(ownerNamespace: string, slug: string, options: { archived?: boolean; private?: boolean } = {}): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: options.private === true ? "private" : "public",
    isArchived: options.archived ?? false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
  return id;
}

async function seedLabel(repoId: string, name: string): Promise<number> {
  const rows = await db()
    .insert(labels)
    .values({ repoId, name, color: "#00aabb", description: "", numIssues: 0, numClosedIssues: 0 })
    .returning({ id: labels.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("label seed failed");
  return row.id;
}

async function seedMilestone(repoId: string, name: string): Promise<number> {
  const rows = await db()
    .insert(milestones)
    .values({ repoId, name, content: "", createdAt: new Date(), updatedAt: new Date() })
    .returning({ id: milestones.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("milestone seed failed");
  return row.id;
}

/** Active webhook subscribed to the given events — the fan-out matcher target. */
async function seedHook(repoId: string, events: string[]): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/issue-test",
      events: JSON.stringify({ choose_events: true, branch_filter: "*", events: Object.fromEntries(events.map((e) => [e, true])) }),
      isActive: true,
      type: "gitea",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: webhooks.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("hook seed failed");
  return row.id;
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`https://example.com${path}`, init), env);
};

/** One issue through the landed service (indexes allocate 1, 2, …). */
async function seedIssue(
  repoId: string,
  title: string,
  options: { posterId?: number; content?: string; labelIds?: number[]; milestoneId?: number | null; closed?: boolean } = {},
): Promise<{ id: number; index: number }> {
  const row = await service().createIssue({
    repoId,
    title,
    content: options.content ?? null,
    posterId: options.posterId ?? null,
    labelIds: options.labelIds ?? [],
    milestoneId: options.milestoneId ?? null,
  });
  if (options.closed === true) {
    await service().closeIssue(row.id, { actorId: options.posterId ?? null });
  }
  return { id: row.id, index: row.index };
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

async function deliveriesFor(hookId: number): Promise<DeliveryRow[]> {
  return db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.hookId, hookId))
    .all();
}

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/issues (issueCreateIssue)
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/issues (issueCreateIssue)", () => {
  it("creates an issue with 201 and the exact contract Issue field set", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "created by the suite", body: "some body", ref: "feature-branch" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(ISSUE_FIELDS);
    expect(body).toMatchObject({
      number: 1, // per-repo index, not the global id
      title: "created by the suite",
      body: "some body",
      ref: "feature-branch",
      state: "open",
      labels: [],
      assets: [],
      repository: { name: "visible", owner: "alice", full_name: "alice/visible" },
      user: { login: "cf-gitea-stub" },
      closed_at: null,
      due_date: null,
      milestone: null,
    });
    expect(body.id).toBeTypeOf("number");
  });

  it("attaches labels and the milestone by id and stores the deadline", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    const milestoneId = await seedMilestone(repoId, "v1");

    const res = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "with enrichments", labels: [labelId], milestone: milestoneId, due_date: "2030-01-02" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ labels: Array<{ id: number }>; milestone: { id: number }; due_date: string | null }>();
    expect(body.labels.map((l) => l.id)).toEqual([labelId]);
    expect(body.milestone?.id).toBe(milestoneId);
    // ApplyAPIDeadlineTimestamp: end of that calendar day (UTC).
    expect(body.due_date).toBe("2030-01-02T23:59:59.000Z");
  });

  it("creates closed when form.closed is set (open webhook, then closed)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const hookId = await seedHook(repoId, ["issues"]);

    const res = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "born closed", closed: true }),
    });
    expect(res.status).toBe(201);
    expect((await res.json<{ state: string }>()).state).toBe("closed");

    const deliveries = await deliveriesFor(hookId);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["opened", "closed"]);
    const opened = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 IssuePayload field set, 2-space serialized by emitWebhookDeliveries.
    expect(Object.keys(opened).sort()).toEqual(["action", "commit_id", "issue", "number", "repository", "sender"]);
    expect(opened.number).toBe(1);
    expect(deliveries[0]!.eventType).toBe("issues");
    expect(deliveries[0]!.payloadContent).toContain('\n  "action": "opened"');
  });

  it("emits the issues opened webhook to subscribed active hooks only", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const hookId = await seedHook(repoId, ["push"]); // not subscribed to issues
    await seedHook(repoId, ["issues"]);

    await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "fan-out target" }),
    });

    // Only the issues-subscribed hook receives a delivery.
    const own = await deliveriesFor(hookId);
    expect(own).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(1);
  });

  it("422s a missing title (bind) and 404s unknown milestone/label ids", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");

    const noTitle = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "no title" }),
    });
    expect(noTitle.status).toBe(422);
    expect((await noTitle.json<{ message: string }>()).message).toBe("invalid request body");

    const badMilestone = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x", milestone: 99 }),
    });
    expect(badMilestone.status).toBe(404);
    expect(await badMilestone.json()).toEqual({
      message: `milestone does not exist [id: 99, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });

    const badLabel = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x", labels: [77] }),
    });
    expect(badLabel.status).toBe(404);
    expect(await badLabel.json()).toEqual({
      message: `label does not exist [label_id: 77, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });

  it("requires a token, a visible repo, and an unarchived repo", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    await seedRepo("alice", "frozen", { archived: true });

    const anon = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "anon" }),
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await router()("/repos/alice/ghost/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });

    const archived = await router()("/repos/alice/frozen/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(archived.status).toBe(423);
    expect(await archived.json()).toEqual({ message: "repo is archived", url: ERROR_URL });
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/issues (issueListIssues)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/issues (issueListIssues)", () => {
  it("lists open issues by default with pagination headers", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "first");
    await seedIssue(repoId, "second");
    await seedIssue(repoId, "old closed one", { closed: true });

    const res = await router()("/repos/alice/visible/issues");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    // created DESC (SortByCreatedDesc)
    expect(body.map((i) => i.title)).toEqual(["second", "first"]);
    expect(Object.keys(body[0]!).sort()).toEqual(ISSUE_FIELDS);
  });

  it("filters by state/labels/q/milestones", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const bug = await seedLabel(repoId, "bug");
    const v1 = await seedMilestone(repoId, "v1");
    await seedIssue(repoId, "labeled one", { labelIds: [bug], milestoneId: v1 });
    await seedIssue(repoId, "plain one");
    await seedIssue(repoId, "closed labeled", { labelIds: [bug], closed: true });

    const byState = await router()("/repos/alice/visible/issues?state=closed");
    expect((await byState.json<Array<{ title: string }>>()).map((i) => i.title)).toEqual(["closed labeled"]);

    const all = await router()("/repos/alice/visible/issues?state=all");
    expect(all.headers.get("X-Total-Count")).toBe("3");

    // state defaults to OPEN upstream — the closed labeled row needs state=all.
    const byLabelOpen = await router()("/repos/alice/visible/issues?labels=bug");
    expect(byLabelOpen.headers.get("X-Total-Count")).toBe("1");
    const byLabel = await router()("/repos/alice/visible/issues?labels=bug,nonexistent&state=all");
    expect(byLabel.headers.get("X-Total-Count")).toBe("2"); // non-existent names discarded, any-of match

    const byQ = await router()("/repos/alice/visible/issues?q=PLAIN");
    expect((await byQ.json<Array<{ title: string }>>()).map((i) => i.title)).toEqual(["plain one"]);

    const byMilestone = await router()("/repos/alice/visible/issues?milestones=v1,99");
    expect((await byMilestone.json<Array<{ title: string }>>()).map((i) => i.title)).toEqual(["labeled one"]);
  });

  it("type=pulls lists only PR rows from the shared counter", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const created = await seedIssue(repoId, "a plain issue");
    const pr = await service().createPullRequest({
      repoId,
      title: "a pr",
      posterId: owner.id,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "feature",
    });
    expect(pr.issue.index).toBe(created.index + 1); // one shared per-repo sequence

    const pulls = await router()("/repos/alice/visible/issues?type=pulls");
    expect(pulls.headers.get("X-Total-Count")).toBe("1");
    const prBody = await pulls.json<Array<{ number: number; pull_request: { merged: boolean; draft: boolean } | null }>>();
    expect(prBody[0]?.number).toBe(pr.issue.index);
    expect(prBody[0]?.pull_request).toMatchObject({ merged: false, draft: false });

    const issuesOnly = await router()("/repos/alice/visible/issues?type=issues");
    expect(issuesOnly.headers.get("X-Total-Count")).toBe("1");
  });

  it("applies since/before RFC3339 filters and 422s bad formats with Go's message", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const fresh = await seedIssue(repoId, "fresh");
    await db().update(issues).set({ updatedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(issues.id, fresh.id));

    const since = await router()("/repos/alice/visible/issues?since=2026-06-01T00:00:00Z");
    expect(since.headers.get("X-Total-Count")).toBe("0");

    const before = await router()("/repos/alice/visible/issues?before=2026-06-01T00:00:00Z");
    expect(before.headers.get("X-Total-Count")).toBe("1");

    const bad = await router()("/repos/alice/visible/issues?since=not-a-date");
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({
      message: 'parsing time "not-a-date" as "2006-01-02T15:04:05Z07:00": cannot parse "not-a-date" as "2006"',
      url: ERROR_URL,
    });
  });

  it("resolves created_by and 422s unknown users", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "by alice", { posterId: owner.id });
    await seedIssue(repoId, "by bob", { posterId: neighbor.id });

    const mine = await router()("/repos/alice/visible/issues?created_by=BOB");
    expect((await mine.json<Array<{ title: string }>>()).map((i) => i.title)).toEqual(["by bob"]);

    const unknown = await router()("/repos/alice/visible/issues?created_by=ghost");
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ message: "user does not exist [name: ghost]", url: ERROR_URL });
  });

  it("404s an invisible repository", async () => {
    await seedUser("Alice");
    const res = await router()("/repos/alice/ghost/issues");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/issues/{index} (issueGetIssue)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/issues/{index} (issueGetIssue)", () => {
  it("returns the enriched issue (labels, milestone, comment count)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    const milestoneId = await seedMilestone(repoId, "v1");
    const issue = await seedIssue(repoId, "enriched", { labelIds: [labelId], milestoneId, posterId: owner.id });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "hello" });

    const res = await router()("/repos/alice/visible/issues/1");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      number: 1,
      title: "enriched",
      comments: 1,
      labels: [{ id: labelId }],
      milestone: { id: milestoneId, title: "v1" },
      user: { login: "Alice" },
      url: "https://example.com/api/v1/repos/alice/visible/issues/1",
      html_url: "https://example.com/alice/visible/issues/1",
    });
  });

  it("404s missing/garbage indexes with the upstream ErrIssueNotExist message", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "one");

    const missing = await router()("/repos/alice/visible/issues/9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      message: `issue does not exist [id: 0, repo_id: ${repoId}, index: 9]`,
      url: ERROR_URL,
    });

    const garbage = await router()("/repos/alice/visible/issues/abc");
    expect(garbage.status).toBe(404);
    expect(await garbage.json()).toEqual({
      message: `issue does not exist [id: 0, repo_id: ${repoId}, index: 0]`,
      url: ERROR_URL,
    });
  });

  it("keeps issue indexes repo-scoped", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedRepo(owner.usernameLower, "other");
    await seedIssue(repoId, "only in visible");

    const res = await router()("/repos/alice/other/issues/1");
    expect(res.status).toBe(404);
    const otherRepoId = String(Number(repoId) + 1);
    expect(await res.json()).toEqual({
      message: `issue does not exist [id: 0, repo_id: ${otherRepoId}, index: 1]`,
      url: ERROR_URL,
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /repos/{owner}/{repo}/issues/{index} (issueEditIssue) — the 201 quirk
// ---------------------------------------------------------------------------

describe("PATCH /repos/{owner}/{repo}/issues/{index} (issueEditIssue)", () => {
  it("answers 201 (upstream quirk) and applies title/body/ref edits", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "before", { posterId: 1, content: "old body" });
    const hookId = await seedHook(repoId, ["issues"]);

    const res = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "after", body: "new body", ref: "refs/heads/main" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ number: 1, title: "after", body: "new body", ref: "refs/heads/main", content_version: 1 });

    // Title edits write the change_title system comment (type 10), the ref
    // edit a change_issue_ref (type 33); body edits bump content_version only.
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    expect(rows.map((r) => r.type)).toEqual([CommentType.ChangeTitle, CommentType.ChangeIssueRef]);
    expect(rows[0]?.oldTitle).toBe("before");
    expect(rows[0]?.newTitle).toBe("after");

    const deliveries = await deliveriesFor(hookId);
    const payloads = deliveries.map((d) => JSON.parse(d.payloadContent) as { action: string; changes?: Record<string, { title?: { from: string }; body?: { from: string } }> });
    expect(payloads.map((p) => p.action)).toEqual(["edited", "edited"]);
    expect(payloads[0]?.changes).toEqual({ title: { from: "before" } });
    expect(payloads[1]?.changes).toEqual({ body: { from: "old body" } });
  });

  it("CAS-guards body edits on content_version with 409", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "cas", { posterId: 1, content: "v0 body" });

    const stale = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "raced", content_version: 5 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ message: "the issue is already changed", url: ERROR_URL });

    const fresh = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "sequenced", content_version: 0 }),
    });
    expect(fresh.status).toBe(201);
    expect((await fresh.json<{ content_version: number }>()).content_version).toBe(1);
  });

  it("transitions state through the CAS service (closed ↔ open) with system comments", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "lifecycle", { posterId: 1 });
    const hookId = await seedHook(repoId, ["issues"]);

    const close = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "closed" }),
    });
    expect(close.status).toBe(201);
    expect((await close.json<{ state: string; closed_at: string | null }>()).state).toBe("closed");

    const reopen = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopen.status).toBe(201);
    expect((await reopen.json<{ state: string; closed_at: string | null }>()).closed_at).toBeNull();

    const types = (await db().select().from(comments).where(eq(comments.issueId, issue.id)).all()).map((r) => r.type);
    expect(types).toEqual([CommentType.Close, CommentType.Reopen]);

    const actions = (await deliveriesFor(hookId)).map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["closed", "reopened"]);
  });

  it("moves the milestone with counter maintenance and a milestone comment", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const milestoneId = await seedMilestone(repoId, "v1");
    const otherMilestone = await seedMilestone(repoId, "v2");
    const issue = await seedIssue(repoId, "moving", { posterId: 1, milestoneId });

    const res = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: otherMilestone }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ milestone: { id: number } | null }>();
    expect(body.milestone?.id).toBe(otherMilestone);

    const ms = await db().select().from(milestones).all();
    expect(ms.find((m) => m.id === milestoneId)?.numIssues).toBe(0);
    expect(ms.find((m) => m.id === otherMilestone)?.numIssues).toBe(1);
    const types = (await db().select().from(comments).where(eq(comments.issueId, issue.id)).all()).map((r) => r.type);
    expect(types).toEqual([CommentType.Milestone]);

    const unknown = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: 42 }),
    });
    expect(unknown.status).toBe(404);
  });

  it("sets and unsets the due date", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "deadline", { posterId: 1 });

    const set = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ due_date: "2031-03-04" }),
    });
    expect(set.status).toBe(201);
    expect((await set.json<{ due_date: string | null }>()).due_date).toBe("2031-03-04T23:59:59.000Z");

    const unset = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ unset_due_date: true }),
    });
    expect(unset.status).toBe(201);
    expect((await unset.json<{ due_date: string | null }>()).due_date).toBeNull();
  });

  it("403s non-poster non-owner editors and 404s missing issues", async () => {
    // Identity note: the stub resolver maps ANY token to STUB_USER (id 1,
    // pinned as a D1 row in beforeEach). alice/bob land on ids 2/3, so the
    // stub identity edits its OWN (API-created) issues via the poster path
    // but not bob's.
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const repoId = await seedRepo(alice.usernameLower, "visible");
    await seedIssue(repoId, "bobs issue", { posterId: bob.id });

    const forbidden = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders, // stub identity: neither poster (bob) nor owner (alice)
      body: JSON.stringify({ title: "hijack" }),
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<{ message: string }>()).message).toBe("");

    // The poster path: the stub identity authored this one (via the API).
    await router()("/repos/alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "stub authored" }),
    });
    const asPoster = await router()("/repos/alice/visible/issues/2", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "renamed by poster" }),
    });
    expect(asPoster.status).toBe(201);

    const missing = await router()("/repos/alice/visible/issues/9", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(missing.status).toBe(404);
  });

  it("423s archived repositories", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "frozen", { archived: true });
    const res = await router()("/repos/alice/frozen/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// DELETE /repos/{owner}/{repo}/issues/{index} (issueDelete)
// ---------------------------------------------------------------------------

describe("DELETE /repos/{owner}/{repo}/issues/{index} (issueDelete)", () => {
  it("cascades the §4.12 delete set and never rewinds the index counter", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    const first = await seedIssue(repoId, "doomed", { posterId: owner.id, labelIds: [labelId] });
    const second = await seedIssue(repoId, "survivor", { posterId: owner.id });
    await service().addComment({ issueId: first.id, posterId: owner.id, content: "will vanish" });

    const res = await router()("/repos/alice/visible/issues/1", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    expect(await db().select().from(issues).all()).toHaveLength(1);
    expect(await db().select().from(comments).all()).toHaveLength(0);
    const detachedLabel = (await db().select().from(labels).where(eq(labels.id, labelId)).all())[0];
    expect(detachedLabel?.numIssues).toBe(0);
    // The repo's open-issue counter drops with the row...
    const repo = await db().select().from(repositories).where(eq(repositories.id, repoId)).all();
    expect(repo[0]?.numIssues).toBe(1);
    // ...but the index counter is NOT rewound: the next create takes 3.
    const next = await service().createIssue({ repoId, title: "after delete" });
    expect(next.index).toBe(second.index + 1);
    const counters = await db().select().from(repoCounters).all();
    expect(counters[0]?.issueIndex).toBe(3);
  });

  it("404s missing issues and 423s archived repos", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");
    await seedRepo(owner.usernameLower, "frozen", { archived: true });

    const missing = await router()("/repos/alice/visible/issues/5", { method: "DELETE", headers: authHeaders });
    expect(missing.status).toBe(404);

    const archived = await router()("/repos/alice/frozen/issues/1", { method: "DELETE", headers: authHeaders });
    expect(archived.status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// Comment routes — the GLOBAL comment id space vs the per-repo issue index
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/issues/{index}/comments (issueCreateComment)", () => {
  it("creates a comment with 201, the contract Comment shape, and the anchor URL", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "commented", { posterId: owner.id });
    const hookId = await seedHook(repoId, ["issue_comment"]);

    const res = await router()("/repos/alice/visible/issues/1/comments", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "a comment" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(COMMENT_FIELDS);
    expect(body).toMatchObject({
      body: "a comment",
      html_url: `https://example.com/alice/visible/issues/1#issuecomment-${String(body.id)}`,
      issue_url: "https://example.com/alice/visible/issues/1",
      pull_request_url: "",
      user: { login: "cf-gitea-stub" },
      assets: [],
    });
    expect(body.id).toBeTypeOf("number");

    // num_comments folds the user comment in.
    const row = await db().select().from(issues).where(eq(issues.id, issue.id)).all();
    expect(row[0]?.numComments).toBe(1);

    // Webhook: issue_comment created with the §2.7 payload shape.
    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("issue_comment");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["action", "comment", "is_pull", "issue", "repository", "sender"]);
    expect(payload).toMatchObject({ action: "created", is_pull: false });
  });

  it("404s a missing issue and 423s archived repos", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");
    await seedRepo(owner.usernameLower, "frozen", { archived: true });

    const missing = await router()("/repos/alice/visible/issues/9/comments", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "x" }),
    });
    expect(missing.status).toBe(404);

    const archived = await router()("/repos/alice/frozen/issues/1/comments", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "x" }),
    });
    expect(archived.status).toBe(423);
  });
});

describe("GET /repos/{owner}/{repo}/issues/{index}/comments (issueGetComments)", () => {
  it("lists only user comments in id order (system comments excluded) with X-Total-Count", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "with comments", { posterId: owner.id });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "first" });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "second" });
    await service().closeIssue(issue.id, { actorId: owner.id }); // system comment in between

    const res = await router()("/repos/alice/visible/issues/1/comments");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2"); // the close system comment stays out
    const body = await res.json<Array<{ id: number; body: string }>>();
    expect(body.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("applies since/before and 422s bad RFC3339", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "timed", { posterId: owner.id });
    const old = await service().addComment({ issueId: issue.id, posterId: owner.id, content: "old" });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "new" });
    await db().update(comments).set({ updatedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(comments.id, old.id));

    const since = await router()("/repos/alice/visible/issues/1/comments?since=2026-06-01T00:00:00Z");
    expect((await since.json<Array<{ body: string }>>()).map((c) => c.body)).toEqual(["new"]);

    const bad = await router()("/repos/alice/visible/issues/1/comments?since=nope");
    expect(bad.status).toBe(422);
  });

  it("404s a missing issue", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    const res = await router()("/repos/alice/visible/issues/9/comments");
    expect(res.status).toBe(404);
  });
});

describe("GET /repos/{owner}/{repo}/issues/comments (issueGetRepoComments)", () => {
  it("lists the repo-wide user-comment feed across issues, paginated", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const a = await seedIssue(repoId, "one");
    const b = await seedIssue(repoId, "two");
    await service().addComment({ issueId: a.id, posterId: owner.id, content: "on one" });
    await service().addComment({ issueId: b.id, posterId: owner.id, content: "on two" });
    await service().closeIssue(a.id, { actorId: owner.id }); // system comment stays out

    const res = await router()("/repos/alice/visible/issues/comments?limit=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="next"');
    const body = await res.json<Array<{ body: string }>>();
    expect(body).toHaveLength(1);
  });

  it("404s missing repos and 422s bad time formats", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    const missing = await router()("/repos/alice/ghost/issues/comments");
    expect(missing.status).toBe(404);
    const bad = await router()("/repos/alice/visible/issues/comments?before=2026-13-99");
    expect(bad.status).toBe(422);
  });
});

describe("GET /repos/{owner}/{repo}/issues/comments/{id} (issueGetComment)", () => {
  it("resolves the GLOBAL comment id within the repo (distinct from issue indexes)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "target", { posterId: owner.id });
    const comment = await service().addComment({ issueId: issue.id, posterId: owner.id, content: "global id" });

    const res = await router()(`/repos/alice/visible/issues/comments/${comment.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: comment.id, body: "global id" });
  });

  it("answers the empty 204 for system comments (upstream GetIssueComment)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "closed one", { posterId: owner.id, closed: true });
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    const closeComment = rows.find((r) => r.type === CommentType.Close);
    expect(closeComment).toBeDefined();

    const res = await router()(`/repos/alice/visible/issues/comments/${String(closeComment!.id)}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("404s comments from other repos and garbage ids with the upstream message", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const otherRepo = await seedRepo(owner.usernameLower, "other");
    const issue = await seedIssue(repoId, "here", { posterId: owner.id });
    const foreignIssue = await seedIssue(otherRepo, "there", { posterId: owner.id });
    const foreign = await service().addComment({ issueId: foreignIssue.id, posterId: owner.id, content: "foreign" });

    const scoped = await router()(`/repos/alice/visible/issues/comments/${foreign.id}`);
    expect(scoped.status).toBe(404);
    expect(await scoped.json()).toEqual({
      message: `comment does not exist [id: ${foreign.id}, issue_id: 0]`,
      url: ERROR_URL,
    });

    const garbage = await router()("/repos/alice/visible/issues/comments/not-an-id");
    expect(garbage.status).toBe(404);
    void issue;
  });
});

describe("PATCH /repos/{owner}/{repo}/issues/comments/{id} (issueEditComment)", () => {
  it("updates the body, bumps content_version, and answers 200", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "edit target", { posterId: 1 });
    const comment = await service().addComment({ issueId: issue.id, posterId: 1, content: "original" });

    const res = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "edited" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: comment.id, body: "edited" });

    const row = await db().select().from(comments).where(eq(comments.id, comment.id)).all();
    expect(row[0]?.contentVersion).toBe(1);
    // unix-second columns: same-second stamps are the floor, not a failure
    expect(row[0]?.updatedAt?.getTime()).toBeGreaterThanOrEqual(row[0]!.createdAt!.getTime());
  });

  it("answers the empty 204 when editing a system comment (no content support)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "system target", { posterId: 1, closed: true }); // close comment authored by the stub
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    const closeComment = rows.find((r) => r.type === CommentType.Close)!;

    const res = await router()(`/repos/alice/visible/issues/comments/${closeComment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "nope" }),
    });
    expect(res.status).toBe(204);
  });

  it("403s non-poster non-owner editors", async () => {
    // The stub identity (id 1) is neither bob's comment poster nor the repo
    // owner (alice) → the bare 403.
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const repoId = await seedRepo(alice.usernameLower, "visible");
    const bobIssue = await seedIssue(repoId, "bobs", { posterId: bob.id });
    const bobComment = await service().addComment({ issueId: bobIssue.id, posterId: bob.id, content: "bob's" });
    const stubEditsBobs = await router()(`/repos/alice/visible/issues/comments/${bobComment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "stub hijack" }),
    });
    expect(stubEditsBobs.status).toBe(403);
  });
});

describe("DELETE /repos/{owner}/{repo}/issues/comments/{id} (issueDeleteComment)", () => {
  it("deletes the comment, folds num_comments back, and answers 204", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "deletion target", { posterId: 1 });
    const comment = await service().addComment({ issueId: issue.id, posterId: 1, content: "doomed" });

    const res = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await db().select().from(comments).all()).toHaveLength(0);
    const row = await db().select().from(issues).where(eq(issues.id, issue.id)).all();
    expect(row[0]?.numComments).toBe(0);
  });

  it("400s deleting system comments (upstream StatusBadRequest, runtime-only)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "system guard", { posterId: 1, closed: true });
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    const closeComment = rows.find((r) => r.type === CommentType.Close)!;

    const res = await router()(`/repos/alice/visible/issues/comments/${closeComment.id}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(400);
    expect(await db().select().from(comments).all()).toHaveLength(1);
  });

  it("404s unknown comments", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    const res = await router()("/repos/alice/visible/issues/comments/999", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Issue label routes — the verb semantics (POST add / PUT replace / DELETE clear)
// ---------------------------------------------------------------------------

describe("issue label routes (issueGetLabels / issueAddLabel / issueReplaceLabels / issueClearLabels)", () => {
  it("lists an issue's labels and 404s missing issues", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const a = await seedLabel(repoId, "alpha");
    const b = await seedLabel(repoId, "beta");
    await seedIssue(repoId, "labeled", { labelIds: [a, b] });

    const res = await router()("/repos/alice/visible/issues/1/labels");
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ id: number; color: string; url: string }>>();
    expect(body.map((l) => l.id)).toEqual([a, b]);
    expect(body[0]?.color).toBe("00aabb"); // hash-less wire color
    expect(body[0]?.url).toBe(`https://example.com/api/v1/repos/alice/visible/labels/${String(a)}`);

    const missing = await router()("/repos/alice/visible/issues/9/labels");
    expect(missing.status).toBe(404);
  });

  it("POST adds (idempotent, by id AND by name) and answers 200 — never 201", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const a = await seedLabel(repoId, "alpha");
    const b = await seedLabel(repoId, "beta");
    await seedIssue(repoId, "target", { labelIds: [a] });

    const byName = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: ["beta"] }),
    });
    expect(byName.status).toBe(200);
    expect((await byName.json<Array<{ id: number }>>()).map((l) => l.id)).toEqual([a, b]);

    const byIdAgain = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [a] }),
    });
    expect(byIdAgain.status).toBe(200);
    expect((await byIdAgain.json<Array<{ id: number }>>()).map((l) => l.id)).toEqual([a, b]); // idempotent
  });

  it("rejects mixed id/name arrays with the runtime 400 and unknown labels with 404", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedLabel(repoId, "alpha");
    await seedIssue(repoId, "target");

    const mixed = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [1, "beta"] }),
    });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toEqual({
      message: "labels should be an array of strings or integers",
      url: ERROR_URL,
    });

    const unknownId = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [999] }),
    });
    expect(unknownId.status).toBe(404);
    expect(await unknownId.json()).toEqual({
      message: `label does not exist [label_id: 999, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });

  it("PUT replaces the whole set (200) and DELETE clears it (204)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const a = await seedLabel(repoId, "alpha");
    const b = await seedLabel(repoId, "beta");
    await seedIssue(repoId, "replace me", { labelIds: [a, b] });

    const put = await router()("/repos/alice/visible/issues/1/labels", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ labels: [b] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json<Array<{ id: number }>>()).map((l) => l.id)).toEqual([b]);

    const del = await router()("/repos/alice/visible/issues/1/labels", { method: "DELETE", headers: authHeaders });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    const empty = await router()("/repos/alice/visible/issues/1/labels");
    expect(await empty.json()).toEqual([]);
  });

  it("keeps label open-counters in step and 423s archived repos on mutations", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    await seedIssue(repoId, "countered");
    await seedRepo(owner.usernameLower, "frozen", { archived: true });

    await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect((await db().select().from(labels).where(eq(labels.id, labelId)).all())[0]?.numIssues).toBe(1);

    await router()("/repos/alice/visible/issues/1/labels", { method: "DELETE", headers: authHeaders });
    expect((await db().select().from(labels).where(eq(labels.id, labelId)).all())[0]?.numIssues).toBe(0);

    const archived = await router()("/repos/alice/frozen/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(archived.status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/issues/{index}/timeline (issueGetCommentsAndTimeline)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/issues/{index}/timeline (issueGetCommentsAndTimeline)", () => {
  it("renders the mixed event stream with per-type metadata", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "timeline", { posterId: 1 });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "a note" });
    await service().closeIssue(issue.id, { actorId: owner.id });
    await service().reopenIssue(issue.id, { actorId: owner.id });
    // Title edit via the route so the change_title row exists.
    await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "timeline (renamed)" }),
    });

    const res = await router()("/repos/alice/visible/issues/1/timeline");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("4");
    const body = await res.json<Array<Record<string, unknown>>>();
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(TIMELINE_FIELDS);
    }
    expect(body.map((i) => i.type)).toEqual(["comment", "close", "reopen", "change_title"]);
    const title = body[3] as Record<string, unknown>;
    // The route editor is the stub identity (id 1 → the pinned stub row).
    expect(title).toMatchObject({ old_title: "timeline", new_title: "timeline (renamed)", user: { login: "cf-gitea-stub" } });
  });

  it("paginates and filters by since/before", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "paged timeline", { posterId: 1 });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "old" });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "new" });
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    await db().update(comments).set({ updatedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(comments.id, rows[0]!.id));

    const page = await router()("/repos/alice/visible/issues/1/timeline?limit=1&page=2");
    expect(page.status).toBe(200);
    // Upstream quirk: the timeline's X-Total-Count counts the PAGE items
    // (SetTotalCountHeader(len(apiComments))), not the full stream.
    expect(page.headers.get("X-Total-Count")).toBe("1");
    expect(page.headers.get("Link")).toContain('rel="prev"');
    expect((await page.json<Array<{ body: string }>>()).map((c) => c.body)).toEqual(["new"]);

    const since = await router()("/repos/alice/visible/issues/1/timeline?since=2026-06-01T00:00:00Z");
    expect(since.headers.get("X-Total-Count")).toBe("1");
  });

  it("404s a missing issue", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    const res = await router()("/repos/alice/visible/issues/9/timeline");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/issues/search (issueSearchIssues)
// ---------------------------------------------------------------------------

describe("GET /repos/issues/search (issueSearchIssues)", () => {
  it("searches across the viewer's visible repositories", async () => {
    const owner = await seedUser("Alice");
    const repoA = await seedRepo(owner.usernameLower, "alpha-repo");
    const repoB = await seedRepo(owner.usernameLower, "beta-repo");
    await seedIssue(repoA, "findme in alpha");
    await seedIssue(repoB, "findme in beta");
    await seedIssue(repoB, "other");

    const res = await router()("/repos/issues/search?q=findme&limit=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2"); // unlike the timeline quirk, search counts the FULL result set
    expect(res.headers.get("Link")).toContain('rel="last"');
    const body = await res.json<Array<{ number: number; repository: { owner: string } }>>();
    expect(body).toHaveLength(1); // limit=1 — the page carries one item
    expect(body[0]?.repository).toMatchObject({ owner: "alice" });
  });

  it("narrow with owner, state and type", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const repoA = await seedRepo(owner.usernameLower, "alpha-repo");
    const repoB = await seedRepo(neighbor.usernameLower, "beta-repo");
    await seedIssue(repoA, "alice open");
    await seedIssue(repoA, "alice closed", { closed: true });
    await seedIssue(repoB, "bob open");

    const byOwner = await router()(`/repos/issues/search?owner=Alice&state=all`);
    expect(byOwner.headers.get("X-Total-Count")).toBe("2"); // state defaults to open otherwise

    const byState = await router()(`/repos/issues/search?owner=Alice&state=closed`);
    expect(byState.headers.get("X-Total-Count")).toBe("1");

    const byType = await router()(`/repos/issues/search?type=pulls`);
    expect(byType.headers.get("X-Total-Count")).toBe("0");
  });

  it("hides private repositories from anonymous search but shows them to the owner", async () => {
    const owner = await seedUser("Alice");
    const publicRepo = await seedRepo(owner.usernameLower, "public-repo");
    const privateRepo = await seedRepo(owner.usernameLower, "private-repo", { private: true });
    await seedIssue(publicRepo, "public findme");
    await seedIssue(privateRepo, "private findme");

    const anon = await router()("/repos/issues/search?q=findme");
    expect(anon.headers.get("X-Total-Count")).toBe("1");

    // The stub resolver identity (cf-gitea-stub) owns nothing.
    const signed = await router()("/repos/issues/search?q=findme", { headers: { Authorization: `token ${TOKEN}` } });
    expect(signed.headers.get("X-Total-Count")).toBe("1");
  });

  it("400s unknown owners and owner-less team filters; 422s bad time formats", async () => {
    await seedUser("Alice");

    const unknownOwner = await router()("/repos/issues/search?owner=ghost");
    expect(unknownOwner.status).toBe(400);
    expect(await unknownOwner.json()).toEqual({ message: "user does not exist [name: ghost]", url: ERROR_URL });

    const teamless = await router()("/repos/issues/search?team=owners");
    expect(teamless.status).toBe(400);
    expect(await teamless.json()).toEqual({
      message: "owner organisation is required for filtering on team",
      url: ERROR_URL,
    });

    const badTime = await router()("/repos/issues/search?since=bogus");
    expect(badTime.status).toBe(422);
  });
});
