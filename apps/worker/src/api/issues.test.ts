/**
 * Tier-1 issue-block routes on real D1 (SPEC-0004 §2.4 rows issueListIssues …
 * issueSearchIssues; behavior per SPEC-0005 §2.2). Pins the upstream gotchas:
 * the POST→201 / PATCH→201 quirks, the per-repo issue index vs GLOBAL comment
 * id id spaces, the 204-on-system-comment GET, the labels verb semantics
 * (POST=add / PUT=replace / DELETE=clear), the mixed-type timeline stream,
 * the RFC3339 since/before 422s, the CAS 409 on stale content_version, the
 * §4.12 delete cascade (index never reused; the tier-2 child sweep —
 * assignees/dependencies/stopwatches/tracked times/attachments+R2/content
 * history/notification states/project memberships), and the webhook triggers
 * (issues opened/edited/closed/reopened + issue_comment created via
 * emitWebhookDeliveries — rows land inline, the Queue enqueue is the
 * executionCtx-guarded no-op under app.request).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import {
  comments,
  issueAssignees,
  issueAttachments,
  issueContentHistory,
  issueDependencies,
  issuePins,
  issueStopwatches,
  issueUsers,
  issues,
  labels,
  milestones,
  notificationStates,
  projectIssues,
  projects,
  pullRequests,
  repoCollaborators,
  repoCounters,
  repoSettings,
  repositories,
  trackedTimes,
  userBlocking,
  users,
  webhookDeliveries,
  webhooks,
} from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { IssuesService } from "../issues/service";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";
import type { TimelineComment } from "./models/issue";
import { toTimelineComment } from "./services/issues";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "./services/engine";
import { findRepositoryByPath, type Viewer } from "./services/repository";

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
    // The §4.12 tier-2 children (the delete-cascade arm seeds every shape).
    "issue_assignees",
    "issue_dependency",
    "tracked_time",
    "stopwatch",
    "issue_attachments",
    "issue_content_history",
    "notification_states",
    "project_issues",
    "projects",
    "pull_requests",
    "comments",
    "issue_labels",
    "issue_user",
    "issues",
    "milestones",
    "labels",
    "repo_counters",
    "repo_settings",
    "repo_collaborators",
    "user_blocking",
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

const ISSUE_FIELDS = Object.keys(contractModelProperties("Issue")).sort();
const COMMENT_FIELDS = Object.keys(contractModelProperties("Comment")).sort();
const TIMELINE_FIELDS = Object.keys(contractModelProperties("TimelineComment")).sort();

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
// Real engine content for the diff-stat trio pins — the pulls.test.ts seed
// recipe (putApiObjects + commitApiChange through the public RPCs). The DO
// cells outlive the per-test D1 wipes, so the pins use UNIQUE repo slugs and
// the seeders stay idempotent on existing refs.
// ---------------------------------------------------------------------------

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One deterministic root commit on `main`, the named branches pointing at
 *  it — idempotent (already-present refs are left alone). Returns the shared
 *  branch tip. */
async function seedEngineBranches(ownerLower: string, slug: string, branches: string[]): Promise<string> {
  const pair = { ownerNamespace: ownerLower, slug };
  const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
  const tips = refTipMap(await engineReads(env, pair).listRefs());
  const land = async (ref: string, oid: string): Promise<void> => {
    const result = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
    if (result.tag !== "committed") {
      throw new Error(`seed ref landing failed: ${ref} (${result.tag})`);
    }
  };
  let tip = tips.get(branchRef("main"))?.target;
  if (tip === undefined) {
    const blob = new TextEncoder().encode(`# ${slug}\n`);
    const blobOid = await gitObjectOid("blob", blob);
    const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
    const person = { name: "seed", email: "seed@issues.invalid", time: 1761000000, tz: "+0000" };
    const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "seed\n" });
    const put = await cell.putApiObjects([
      { oid: blobOid, type: "blob", data: blob },
      { oid: tree.oid, type: "tree", data: tree.data },
      { oid: commit.oid, type: "commit", data: commit.data },
    ]);
    if (put.tag !== "ok") {
      throw new Error(`seed putApiObjects failed: ${put.tag}`);
    }
    tip = commit.oid;
    await land(branchRef("main"), commit.oid);
  }
  for (const branch of branches) {
    if (tips.get(branchRef(branch)) === undefined) {
      await land(branchRef(branch), tip);
    }
  }
  return tip;
}

/** One CHILD commit on `branch` (parent = parentOid) replacing the whole tree
 *  with `files`. Returns the new branch tip. */
async function landChildCommit(
  ownerLower: string,
  slug: string,
  branch: string,
  parentOid: string,
  files: { name: string; content: string }[],
  message: string,
): Promise<string> {
  const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
  const objects: { oid: string; type: "blob" | "tree" | "commit" | "tag"; data: Uint8Array }[] = [];
  const entries: { mode: "100644"; name: string; oid: string }[] = [];
  for (const file of files) {
    const blob = new TextEncoder().encode(file.content);
    const blobOid = await gitObjectOid("blob", blob);
    objects.push({ oid: blobOid, type: "blob", data: blob });
    entries.push({ mode: "100644", name: file.name, oid: blobOid });
  }
  const tree = serializeTree(entries);
  objects.push({ oid: tree.oid, type: "tree", data: tree.data });
  const person = { name: "seed", email: "seed@issues.invalid", time: 1761000001, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [parentOid], author: person, committer: person, message });
  objects.push({ oid: commit.oid, type: "commit", data: commit.data });
  const put = await cell.putApiObjects(objects);
  if (put.tag !== "ok") {
    throw new Error(`child commit seed putApiObjects failed: ${put.tag}`);
  }
  const result = await cell.commitApiChange({ ref: branchRef(branch), expectedOldOid: parentOid, newOid: commit.oid });
  if (result.tag !== "committed") {
    throw new Error(`child commit ref landing failed: ${result.tag}`);
  }
  return commit.oid;
}

/** Land `refs/pull/N/head` at a tip — what the API POST /pulls route does and
 *  the diff-stat range's head read needs (the service-created PRs of these
 *  pins skip that route). */
async function landPullHeadRef(ownerLower: string, slug: string, index: number, oid: string): Promise<void> {
  const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
  const landed = await cell.commitApiChange({ ref: `refs/pull/${index}/head`, expectedOldOid: ZERO_OID, newOid: oid });
  if (landed.tag !== "committed") {
    throw new Error(`seed pull head landing failed: ${landed.tag}`);
  }
}

/** The diff-stat trio pins' PR fixture: engine branches main+topic with a
 *  real child diff (README rewritten = 1 add + 1 del, notes.txt added = 3
 *  lines — the three-dot range sums to 4/1/2, the pulls.test.ts GET pin's
 *  math), the service-created PR, and its refs/pull/N/head landing. */
async function seedTrioPr(
  ownerLower: string,
  slug: string,
  title: string,
): Promise<{ repoId: string; issueIndex: number; pullIndex: number }> {
  const repoId = await seedRepo(ownerLower, slug);
  const tip = await seedEngineBranches(ownerLower, slug, ["topic"]);
  const child = await landChildCommit(ownerLower, slug, "topic", tip, [
    { name: "README.md", content: `# ${slug} v2\n` },
    { name: "notes.txt", content: "a\nb\nc\n" },
  ], "child\n");
  const pull = await service().createPullRequest({
    repoId,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "topic",
    title,
    posterId: 1,
  });
  await landPullHeadRef(ownerLower, slug, pull.pullRequest.index, child);
  return { repoId, issueIndex: pull.issue.index, pullIndex: pull.pullRequest.index };
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

  it("renders the opened payload issue block null/null (the ToAPIIssue emission witness — the create route drops assignees)", async () => {
    // Upstream's NewIssue (notifier.go:305) renders the opened payload issue
    // through the SHARED ToAPIIssue — for a fresh unassigned issue that is
    // the Go nils, `null` for both fields (the len>0 gate), never []. This
    // route drops form.assignee(s) (the file-header deviation), so its fresh
    // issues are ALWAYS unassigned and the wire render IS upstream's render;
    // a create-assignee wave must split the paths before any other arm can
    // exist here.
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const hookId = await seedHook(repoId, ["issues"]);

    const res = await router()("/repos/Alice/visible/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "born empty" }),
    });
    expect(res.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action)).toEqual(["opened"]);
    const payload = JSON.parse(deliveries[0]!.payloadContent) as {
      issue: { assignee: unknown; assignees: unknown };
    };
    expect(payload.issue.assignee).toBeNull();
    expect(payload.issue.assignees).toBeNull();
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

    // The keyword arm must not cap (the 943e1e9 org-members class — D1's
    // 50-byte LIKE pattern limit): a 200-char needle answers the clean
    // empty list, not a D1_ERROR 500.
    const longQ = await router()(`/repos/alice/visible/issues?q=${"z".repeat(200)}`);
    expect(longQ.status).toBe(200);
    expect(longQ.headers.get("X-Total-Count")).toBe("0");

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

  it("resolves created_by and 404s unknown users with the upstream text", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "by alice", { posterId: owner.id });
    await seedIssue(repoId, "by bob", { posterId: neighbor.id });

    const mine = await router()("/repos/alice/visible/issues?created_by=BOB");
    expect((await mine.json<Array<{ title: string }>>()).map((i) => i.title)).toEqual(["by bob"]);

    // getUserIDForFilter → APIErrorAuto(ErrUserNotExist): the ErrNotExist
    // family renders 404 with the ErrUserNotExist text, UID unset = 0
    // (repo/issue.go:469-479, models/user/error.go:46-58).
    const unknown = await router()("/repos/alice/visible/issues?created_by=ghost");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ message: "user does not exist [uid: 0, name: ghost]", url: ERROR_URL });

    // The lookup is case-insensitive (lower_name = ToLower(name)) but the
    // error echoes the name as given (ErrUserNotExist{Name: name}).
    const unknownCase = await router()("/repos/alice/visible/issues?created_by=Ghost");
    expect(unknownCase.status).toBe(404);
    expect(await unknownCase.json()).toEqual({ message: "user does not exist [uid: 0, name: Ghost]", url: ERROR_URL });
  });

  it("resolves assigned_by/mentioned_by — unknown users 404; users without rows match the empty set", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "by alice", { posterId: owner.id });

    // No assignee/mention ROWS exist in this seed, so a RESOLVED user
    // matches the empty set — but the resolution itself still runs
    // upstream's getUserIDForFilter (repo/issue.go:402-406) before any
    // filtering (the wired filters are pinned just below).
    const known = await router()("/repos/alice/visible/issues?assigned_by=BOB&mentioned_by=Bob");
    expect(known.status).toBe(200);
    expect(await known.json<unknown[]>()).toEqual([]);

    // Unknown logins short-circuit with the ErrUserNotExist 404 —
    // assigned_by first, then mentioned_by (upstream's resolution order).
    const unknownAssigned = await router()("/repos/alice/visible/issues?assigned_by=ghost");
    expect(unknownAssigned.status).toBe(404);
    expect(await unknownAssigned.json()).toEqual({
      message: "user does not exist [uid: 0, name: ghost]",
      url: ERROR_URL,
    });

    const unknownMentioned = await router()("/repos/alice/visible/issues?mentioned_by=ghost");
    expect(unknownMentioned.status).toBe(404);
    expect(await unknownMentioned.json()).toEqual({
      message: "user does not exist [uid: 0, name: ghost]",
      url: ERROR_URL,
    });

    // created_by wins the poster filter; a later unknown assigned_by still
    // 404s even though the list could already be scoped.
    const mixed = await router()(`/repos/alice/visible/issues?created_by=${neighbor.usernameLower}&assigned_by=ghost`);
    expect(mixed.status).toBe(404);
    expect(await mixed.json()).toEqual({
      message: "user does not exist [uid: 0, name: ghost]",
      url: ERROR_URL,
    });
  });

  it("assigned_by filters over the issue_assignees rows — the wired numeric arm (issue_search.go:373-383)", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const assigned = await seedIssue(repoId, "bob's issue", { posterId: owner.id });
    await seedIssue(repoId, "unassigned", { posterId: owner.id });
    await db().insert(issueAssignees).values({ issueId: assigned.id, assigneeId: neighbor.id });

    const bobList = await router()("/repos/alice/visible/issues?assigned_by=BOB");
    expect(bobList.status).toBe(200);
    const bobRows = await bobList.json<{ title: string }[]>();
    expect(bobRows.map((row) => row.title)).toEqual(["bob's issue"]);

    // A resolved user with no assignments still matches empty (the subquery
    // finds nothing — same observable as the pre-wiring sentinel).
    const aliceList = await router()("/repos/alice/visible/issues?assigned_by=alice");
    expect(aliceList.status).toBe(200);
    expect(await aliceList.json<unknown[]>()).toEqual([]);
  });

  it("mentioned_by filters over the issue_user carrier rows — the wired applyMentionedCondition arm", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const third = await seedUser("Carol");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const mentioned = await seedIssue(repoId, "bob was mentioned", { posterId: owner.id });
    const both = await seedIssue(repoId, "bob and carol", { posterId: owner.id });
    await seedIssue(repoId, "unmentioned", { posterId: owner.id });
    // The carrier's row shape (UpdateIssueUsersByMentions): the (user_id,
    // issue_id) pair, is_mentioned flipped. uid = the MENTIONED user.
    await db().insert(issueUsers).values([
      { userId: neighbor.id, issueId: mentioned.id, isMentioned: true },
      { userId: neighbor.id, issueId: both.id, isMentioned: true },
      { userId: third.id, issueId: both.id, isMentioned: true },
    ]);

    const bobList = await router()("/repos/alice/visible/issues?mentioned_by=BOB");
    expect(bobList.status).toBe(200);
    const bobRows = await bobList.json<{ title: string }[]>();
    // SortByCreatedDesc (created_unix DESC, id DESC): the second seed is
    // the newer row on a tied stamp.
    expect(bobRows.map((row) => row.title)).toEqual(["bob and carol", "bob was mentioned"]);

    const carolList = await router()("/repos/alice/visible/issues?mentioned_by=carol");
    expect(carolList.status).toBe(200);
    const carolRows = await carolList.json<{ title: string }[]>();
    expect(carolRows.map((row) => row.title)).toEqual(["bob and carol"]);

    // A resolved user with no mention rows matches empty; the unknown-login
    // 404 arm is pinned above.
    const emptyList = await router()("/repos/alice/visible/issues?mentioned_by=alice");
    expect(emptyList.status).toBe(200);
    expect(await emptyList.json<unknown[]>()).toEqual([]);
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
// pin_order (convert toIssue's LoadPinOrder — models/issues/issue.go:272-284)
// ---------------------------------------------------------------------------

describe("pin_order renders the real pin order (LoadPinOrder -1→0)", () => {
  it("renders the pinned row's order and 0 for unpinned issues", async () => {
    // The beforeEach-pinned stub identity (id 1, login cf-gitea-stub) owns
    // this repo so the pin route's writer gate passes.
    const repoId = await seedRepo("cf-gitea-stub", "pins");
    await seedIssue(repoId, "first");
    await seedIssue(repoId, "unpinned");
    await seedIssue(repoId, "third");

    // The write path allocates max_order + 1 per half (issue_pin.go:73-82).
    expect((await router()("/repos/cf-gitea-stub/pins/issues/1/pin", { method: "POST", headers: authHeaders })).status).toBe(204);
    expect((await router()("/repos/cf-gitea-stub/pins/issues/3/pin", { method: "POST", headers: authHeaders })).status).toBe(204);

    const first = await router()("/repos/cf-gitea-stub/pins/issues/1");
    expect(first.status).toBe(200);
    expect(((await first.json<Record<string, unknown>>())).pin_order).toBe(1);

    const unpinned = await router()("/repos/cf-gitea-stub/pins/issues/2");
    expect(unpinned.status).toBe(200);
    expect(((await unpinned.json<Record<string, unknown>>())).pin_order).toBe(0); // -1 → 0

    const third = await router()("/repos/cf-gitea-stub/pins/issues/3");
    expect(third.status).toBe(200);
    expect(((await third.json<Record<string, unknown>>())).pin_order).toBe(2);
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
    const payloads = deliveries.map((d) => JSON.parse(d.payloadContent) as { action: string; issue: { assignee: unknown; assignees: unknown }; changes?: Record<string, { title?: { from: string }; body?: { from: string } }> });
    expect(payloads.map((p) => p.action)).toEqual(["edited", "edited"]);
    expect(payloads[0]?.changes).toEqual({ title: { from: "before" } });
    expect(payloads[1]?.changes).toEqual({ body: { from: "old body" } });
    // The unassigned issue's EMPTY assignee set renders the Go nils in both
    // edited payloads — `null` for both fields (ToAPIIssue's len>0 gate),
    // never [] — upstream's IssueChangeTitle:238 / IssueChangeContent:410
    // ToAPIIssue render for the same issue.
    for (const payload of payloads) {
      expect(payload.issue.assignee).toBeNull();
      expect(payload.issue.assignees).toBeNull();
    }
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

  it("412s ANY state arm on a merged PR through the issues route (upstream checks HasMerged before the value)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "merged via issues route",
      posterId: 1,
    });
    await db().update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, pull.pullRequest.id));

    // Upstream (repo/issue.go:810-817) loads the PR whenever form.State is
    // set and answers 412 on HasMerged — the guard runs BEFORE the requested
    // value is examined, so the close arm and the reopen arm both 412 with
    // the same message as the pulls-surface twin (pull.go's EditPullRequest).
    const close = await router()(`/repos/alice/visible/issues/${pull.issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "closed" }),
    });
    expect(close.status).toBe(412);
    expect(await close.json()).toEqual({
      message: "cannot change state of this pull request, it was already merged",
      url: ERROR_URL,
    });

    const reopen = await router()(`/repos/alice/visible/issues/${pull.issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopen.status).toBe(412);
    expect(await reopen.json()).toEqual({
      message: "cannot change state of this pull request, it was already merged",
      url: ERROR_URL,
    });
  });

  it("keeps the unmerged-PR state arms working through the issues route", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "unmerged lifecycle",
      posterId: 1,
    });

    const close = await router()(`/repos/alice/visible/issues/${pull.issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "closed" }),
    });
    expect(close.status).toBe(201);
    expect((await close.json<{ state: string }>()).state).toBe("closed");

    const reopen = await router()(`/repos/alice/visible/issues/${pull.issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopen.status).toBe(201);
    expect((await reopen.json<{ state: string; closed_at: string | null }>()).closed_at).toBeNull();
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

  it("renders the title/body/closed/reopened payload issue blocks with the REAL assignee set (the ToAPIIssue emission witness)", async () => {
    // Upstream's issue-state notifiers render every payload issue through the
    // SHARED convert.ToAPIIssue — title edit IssueChangeTitle:238, body edit
    // IssueChangeContent:410, close/reopen IssueChangeStatus:274 — the same
    // LoadAssignees block as the wire render (services/convert/issue.go:
    // 105-112). The emission-align wave dropped the route's four null pins,
    // so all four payloads ride the default wire render — flipping back to
    // the landed nulls must break here.
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("neighbor");
    const recluse = await seedUser("recluse");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "before", { posterId: 1, content: "old body" });
    await db().insert(issueAssignees).values([
      { issueId: issue.id, assigneeId: neighbor.id },
      { issueId: issue.id, assigneeId: recluse.id },
    ]);
    const hookId = await seedHook(repoId, ["issues"]);

    const titleEdit = await router()(`/repos/alice/visible/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "after" }),
    });
    expect(titleEdit.status).toBe(201);

    const bodyEdit = await router()(`/repos/alice/visible/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "new body" }),
    });
    expect(bodyEdit.status).toBe(201);

    const close = await router()(`/repos/alice/visible/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "closed" }),
    });
    expect(close.status).toBe(201);

    const reopen = await router()(`/repos/alice/visible/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopen.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issues", "issues", "issues", "issues"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["edited", "edited", "closed", "reopened"]);
    // Edge-row (insertion) order — the listIssueAssignees orderBy — with the
    // first assignee duplicated into `assignee` (ToIssue issue.go:105-113),
    // IDENTICALLY across all four state emissions: one shared converter, one
    // render.
    for (const delivery of deliveries) {
      const payload = JSON.parse(delivery.payloadContent) as {
        issue: { assignee: { login: string } | null; assignees: Array<{ login: string }> | null };
      };
      expect(payload.issue.assignees?.map((u) => u.login)).toEqual([neighbor.usernameLower, recluse.usernameLower]);
      expect(payload.issue.assignee).toMatchObject({ login: neighbor.usernameLower });
    }
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

  it("sweeps every tier-2 child with the issue: assignees, dependencies (both directions), stopwatch, tracked times, attachments (+ R2 objects), content history, notification states", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const doomed = await seedIssue(repoId, "doomed", { posterId: owner.id, content: "original body" });
    const survivor = await seedIssue(repoId, "survivor", { posterId: owner.id });
    const keeper = await seedIssue(repoId, "keeper", { posterId: owner.id });
    const otherRepoId = await seedRepo(owner.usernameLower, "other");
    const foreign = await seedIssue(otherRepoId, "foreign", { posterId: owner.id });
    const now = new Date("2026-02-03T04:05:06Z");

    // Every child shape on `doomed` (upstream DeleteBeans,
    // services/issue/issue.go:234-252), plus same-shape controls on the
    // survivor issues — including a cross-repo dependency INTO `doomed` —
    // that the sweep must leave alone.
    await db().insert(issueAssignees).values([
      { issueId: doomed.id, assigneeId: neighbor.id },
      { issueId: survivor.id, assigneeId: neighbor.id }, // control
    ]);
    await db().insert(issueDependencies).values([
      { userId: owner.id, issueId: doomed.id, dependencyId: survivor.id, createdAt: now }, // doomed is blocked by survivor
      { userId: owner.id, issueId: foreign.id, dependencyId: doomed.id, createdAt: now }, // foreign is blocked by doomed (reverse direction)
      { userId: owner.id, issueId: survivor.id, dependencyId: keeper.id, createdAt: now }, // control
    ]);
    await db().insert(issueStopwatches).values([
      { issueId: doomed.id, userId: owner.id, createdAt: now },
      { issueId: survivor.id, userId: owner.id, createdAt: now }, // control
    ]);
    await db().insert(trackedTimes).values([
      { issueId: doomed.id, userId: owner.id, seconds: 90, createdAt: now },
      { issueId: survivor.id, userId: owner.id, seconds: 60, createdAt: now }, // control
    ]);
    await db().insert(issueContentHistory).values([
      { posterId: owner.id, issueId: doomed.id, commentId: 0, editedAt: now, contentText: "original body", isFirstCreated: true },
      { posterId: owner.id, issueId: survivor.id, commentId: 0, editedAt: now, contentText: "kept body", isFirstCreated: true }, // control
    ]);
    await db().insert(notificationStates).values([
      { userId: owner.id, issueId: doomed.id, readAtUnix: 42, pinned: true, updatedAt: now },
      { userId: owner.id, issueId: survivor.id, readAtUnix: 42, pinned: true, updatedAt: now }, // control
    ]);
    // The ProjectIssue detach (issue.go:246): both issues sit on one repo
    // project's column; the delete must sweep only the doomed membership.
    const [project] = await db()
      .insert(projects)
      .values({ title: "sweep", creatorId: owner.id, repoId, type: 2, createdAt: now, updatedAt: now })
      .returning()
      .all();
    if (project === undefined) throw new Error("project seed failed");
    await db().insert(projectIssues).values([
      { issueId: doomed.id, projectId: project.id, projectColumnId: 0, sorting: 0 },
      { issueId: survivor.id, projectId: project.id, projectColumnId: 0, sorting: 1 }, // control
    ]);
    // Attachments: one completed (row + R2 object), one row-first-pending
    // (r2_key still NULL — the relay upload never completed) on the doomed
    // issue; a completed control on the survivor.
    const [doomedAsset] = await db()
      .insert(issueAttachments)
      .values({ uuid: "u-doomed", issueId: doomed.id, commentId: 0, uploaderId: owner.id, name: "doomed.txt", size: 5, createdAt: now })
      .returning()
      .all();
    if (doomedAsset === undefined) throw new Error("attachment seed failed");
    const doomedKey = `repos/r_${repoId}/attachments/${doomedAsset.id}/doomed.txt`;
    await env.REPO_PACKS.put(doomedKey, "bytes");
    await db().update(issueAttachments).set({ r2Key: doomedKey }).where(eq(issueAttachments.id, doomedAsset.id));
    const [pendingAsset] = await db()
      .insert(issueAttachments)
      .values({ uuid: "u-pending", issueId: doomed.id, commentId: 0, uploaderId: owner.id, name: "pending.txt", createdAt: now })
      .returning()
      .all();
    if (pendingAsset === undefined) throw new Error("attachment seed failed");
    const [keptAsset] = await db()
      .insert(issueAttachments)
      .values({ uuid: "u-kept", issueId: survivor.id, commentId: 0, uploaderId: owner.id, name: "kept.txt", createdAt: now })
      .returning()
      .all();
    if (keptAsset === undefined) throw new Error("attachment seed failed");
    const keptKey = `repos/r_${repoId}/attachments/${keptAsset.id}/kept.txt`;
    await env.REPO_PACKS.put(keptKey, "kept-bytes");
    await db().update(issueAttachments).set({ r2Key: keptKey }).where(eq(issueAttachments.id, keptAsset.id));

    const res = await router()(`/repos/alice/visible/issues/${doomed.index}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);

    // D1 read-backs: every doomed-child row is gone; every control row (and
    // the cross-repo dependency edge INTO doomed is checked from BOTH sides).
    expect(await db().select().from(issueAssignees).where(eq(issueAssignees.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(issueAssignees).where(eq(issueAssignees.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(issueDependencies).where(eq(issueDependencies.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(issueDependencies).where(eq(issueDependencies.dependencyId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(issueDependencies).where(eq(issueDependencies.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(issueStopwatches).where(eq(issueStopwatches.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(issueStopwatches).where(eq(issueStopwatches.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(trackedTimes).where(eq(trackedTimes.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(trackedTimes).where(eq(trackedTimes.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(issueContentHistory).where(eq(issueContentHistory.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(issueContentHistory).where(eq(issueContentHistory.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(notificationStates).where(eq(notificationStates.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(notificationStates).where(eq(notificationStates.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(projectIssues).where(eq(projectIssues.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(projectIssues).where(eq(projectIssues.issueId, survivor.id)).all()).toHaveLength(1);
    expect(await db().select().from(issueAttachments).where(eq(issueAttachments.issueId, doomed.id)).all()).toHaveLength(0);
    expect(await db().select().from(issueAttachments).where(eq(issueAttachments.issueId, survivor.id)).all()).toHaveLength(1);

    // R2 read-backs: the completed doomed object is gone; the survivor's
    // object stays (the pending row had no object to delete).
    expect(await env.REPO_PACKS.head(doomedKey)).toBeNull();
    expect((await env.REPO_PACKS.head(keptKey))?.size).toBe("kept-bytes".length);
    expect(await db().select().from(issues).where(eq(issues.id, survivor.id)).all()).toHaveLength(1);
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
    // The fresh issue's EMPTY assignee set renders the Go nils — `null` for
    // both fields (ToAPIIssue's len>0 gate), never [] — upstream's
    // CreateIssueComment:482 ToAPIIssue render for the same fresh issue.
    const emptyIssue = payload.issue as { assignee: unknown; assignees: unknown };
    expect(emptyIssue.assignee).toBeNull();
    expect(emptyIssue.assignees).toBeNull();
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

  it("422s an empty and an absent body (CreateIssueCommentOption's binding:\"Required\" → APIErrorValidation, api.go:838-845)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "bind target", { posterId: owner.id });

    const empty = await router()("/repos/alice/visible/issues/1/comments", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "" }),
    });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ message: "invalid request body", url: ERROR_URL });

    const absent = await router()("/repos/alice/visible/issues/1/comments", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(absent.status).toBe(422);
    expect(await absent.json()).toEqual({ message: "invalid request body", url: ERROR_URL });

    // The bind fires before ANY handler arm — nothing was written.
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("403s 'You cannot comment on a locked issue.' without a write grant; a collaborator-writer and a site admin comment through (issue_comment.go:381)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "locked");
    const issue = await seedIssue(repoId, "locked conversation", { posterId: owner.id });
    await db().update(issues).set({ isLocked: true }).where(eq(issues.id, issue.id));

    // The stub (id 1) holds no grant on alice's repo — the lock 403 carries
    // upstream's locale string repo.issues.comment_on_locked verbatim.
    const denied = await router()(`/repos/alice/locked/issues/${issue.index}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "locked out" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      message: "You cannot comment on a locked issue.",
      url: ERROR_URL,
    });

    // A write-grade collaborator passes CanWriteIssuesOrPulls' reduction.
    await db().insert(repoCollaborators).values({ repoId, userId: 1, mode: "write", createdAt: new Date() });
    const writer = await router()(`/repos/alice/locked/issues/${issue.index}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "writers comment through locks" }),
    });
    expect(writer.status).toBe(201);

    // The site admin bypasses too (ctx.Doer.IsAdmin arm) — STUB_USER is
    // frozen at is_admin:false, so the admin identity rides its own router.
    const adminApp = createApiRouter({ auth: { resolveToken: () => Promise.resolve({ ...STUB_USER, is_admin: true }) } });
    const admin = await adminApp.fetch(
      new Request(`https://example.com/repos/alice/locked/issues/${issue.index}/comments`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ body: "admins comment through locks" }),
      }),
      env,
    );
    expect(admin.status).toBe(201);
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

  it("422s an empty and an absent body (EditIssueCommentOption's binding:\"Required\" fires in the bind middleware, structs/issue_comment.go:45)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "edit bind target", { posterId: 1 });
    const comment = await service().addComment({ issueId: issue.id, posterId: 1, content: "original" });

    const empty = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "" }),
    });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ message: "invalid request body", url: ERROR_URL });

    const absent = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(absent.status).toBe(422);
    expect(await absent.json()).toEqual({ message: "invalid request body", url: ERROR_URL });

    // The 422 fires before the handler — the comment row is untouched.
    const row = await db().select().from(comments).where(eq(comments.id, comment.id)).all();
    expect(row[0]?.content).toBe("original");
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

  it("attaches an owner-org label by id on an org-owned repo and renders the org URL — while the repo label list stays repo-only", async () => {
    // The upstream org union (prepareForReplaceOrAdd, routers/api/v1/repo/
    // issue_label.go:304-370): an org-owned repo's issues carry the OWNER
    // ORG's labels; attached org rows render convert.ToLabel's org branch
    // (services/convert/issue.go:269-280). The admin list does NOT union
    // (repo/label.go:52,58) — the pinned asymmetry.
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = ?").bind(owner.id).run();
    const repoLabel = await seedLabel(repoId, "repo-side");
    const orgLabel = await db()
      .insert(labels)
      .values({ repoId: null, orgId: owner.id, name: "org-wide", color: "#778899", description: "" })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    await seedIssue(repoId, "org-labeled");

    const add = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [orgLabel] }),
    });
    expect(add.status).toBe(200);
    const added = await add.json<Array<{ id: number; url: string }>>();
    expect(added.map((l) => l.id)).toEqual([orgLabel]);
    expect(added[0]?.url).toBe(`https://example.com/api/v1/orgs/Alice/labels/${String(orgLabel)}`);

    // The issue render rides the attach rows with the org shape …
    const list = await router()("/repos/alice/visible/issues/1/labels");
    expect((await list.json<Array<{ url: string }>>())[0]?.url).toBe(
      `https://example.com/api/v1/orgs/Alice/labels/${String(orgLabel)}`,
    );
    const detail = await router()("/repos/alice/visible/issues/1");
    expect((await detail.json<{ labels: Array<{ url: string }> }>()).labels[0]?.url).toBe(
      `https://example.com/api/v1/orgs/Alice/labels/${String(orgLabel)}`,
    );

    // … while the repo label ADMIN list stays repo-only.
    const admin = await router()("/repos/alice/visible/labels");
    expect((await admin.json<Array<{ id: number }>>()).map((l) => l.id)).toEqual([repoLabel]);
  });

  it("falls org-only names through to the owner org and keeps repo names repo-wins (pin 7448b49aac)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = ?").bind(owner.id).run();
    const shared = await seedLabel(repoId, "shared"); // the repo AND the org carry the name
    await db()
      .insert(labels)
      .values({ repoId: null, orgId: owner.id, name: "shared", color: "#778899", description: "" })
      .returning({ id: labels.id })
      .all();
    const orgOnly = await db()
      .insert(labels)
      .values({ repoId: null, orgId: owner.id, name: "org-only", color: "#445566", description: "" })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    await seedIssue(repoId, "by-name");
    await seedIssue(repoId, "shared-name");

    const orgName = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: ["org-only"] }),
    });
    expect(orgName.status).toBe(200);
    expect((await orgName.json<Array<{ id: number }>>()).map((l) => l.id)).toEqual([orgOnly]);

    // A name carried by BOTH attaches the repo label only — the org label is
    // NOT double-attached (the pin's repo-wins fix).
    const sharedName = await router()("/repos/alice/visible/issues/2/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: ["shared"] }),
    });
    expect(sharedName.status).toBe(200);
    expect((await sharedName.json<Array<{ id: number }>>()).map((l) => l.id)).toEqual([shared]);
  });

  it("PUT replaces with a mixed repo+org id set and still rejects foreign-repo ids on the org-owned repo", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = ?").bind(owner.id).run();
    const repoLabel = await seedLabel(repoId, "repo-side");
    const orgLabel = await db()
      .insert(labels)
      .values({ repoId: null, orgId: owner.id, name: "org-wide", color: "#778899", description: "" })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    await seedIssue(repoId, "mixed");
    const otherRepo = await seedRepo(owner.usernameLower, "other");
    const foreign = await seedLabel(otherRepo, "foreign");

    const put = await router()("/repos/alice/visible/issues/1/labels", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ labels: [orgLabel, repoLabel] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json<Array<{ id: number; url: string }>>()).map((l) => l.id)).toEqual([repoLabel, orgLabel].sort((a, b) => a - b));

    // Our id validation stays owner-scoped (GetLabelInRepoOrOrgByID's shape,
    // models/issues/label.go:344-354) — a foreign-REPO id is the same 404 as
    // a missing one, unlike upstream's unscoped GetLabelsByIDs id branch at
    // this pin (documented divergence).
    const foreignPut = await router()("/repos/alice/visible/issues/1/labels", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ labels: [foreign] }),
    });
    expect(foreignPut.status).toBe(404);
    expect(await foreignPut.json()).toEqual({
      message: `label does not exist [label_id: ${foreign}, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });

  it("rejects org label ids on user-owned repos as today (owner is not an org)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const orgLabel = await db()
      .insert(labels)
      .values({ repoId: null, orgId: owner.id, name: "org-wide", color: "#778899", description: "" })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);
    await seedIssue(repoId, "user-owned");

    const add = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [orgLabel] }),
    });
    expect(add.status).toBe(404);
    expect(await add.json()).toEqual({
      message: `label does not exist [label_id: ${orgLabel}, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });
});

// ---------------------------------------------------------------------------
// issue_label / pull_request_label webhook emissions (upstream
// services/webhook/notifier.go IssueChangeLabels:572-605 / IssueClearLabels:
// 46-73 — the `issue.IsPull` discriminant picks the event type; payload =
// the shared Issue/PullRequest wrapper with NO `changes` block).
// ---------------------------------------------------------------------------

describe("issue label webhook emissions (issueAddLabel / issueReplaceLabels / issueClearLabels)", () => {
  it("emits label_updated on POST and PUT and label_cleared on DELETE, with the IssuePayload field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const a = await seedLabel(repoId, "alpha");
    const b = await seedLabel(repoId, "beta");
    await seedIssue(repoId, "labeled");
    const hookId = await seedHook(repoId, ["issue_label"]);

    const add = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [a, b] }),
    });
    expect(add.status).toBe(200);

    const replace = await router()("/repos/alice/visible/issues/1/labels", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ labels: [b] }),
    });
    expect(replace.status).toBe(200);

    const clear = await router()("/repos/alice/visible/issues/1/labels", { method: "DELETE", headers: authHeaders });
    expect(clear.status).toBe(204);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_label", "issue_label", "issue_label"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["label_updated", "label_updated", "label_cleared"]);
    const added = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 IssuePayload (hook.go:435) — the label notifiers set NO `changes`.
    expect(Object.keys(added).sort()).toEqual(["action", "commit_id", "issue", "number", "repository", "sender"]);
    expect(added.number).toBe(1);
    expect(added.commit_id).toBe("");
    expect((added.issue as { labels: Array<{ id: number }> }).labels.map((l) => l.id)).toEqual([a, b]);
    expect(added.repository).toMatchObject({ full_name: "alice/visible" });
    // The EMPTY assignee set renders the Go nils — `null` for both fields
    // (structs/issue.go:65-66, no omitempty), never [].
    const emptyIssue = added.issue as { assignee: unknown; assignees: unknown };
    expect(emptyIssue.assignee).toBeNull();
    expect(emptyIssue.assignees).toBeNull();
    expect(deliveries[2]!.payloadContent).toContain('\n  "action": "label_cleared"');
  });

  it("renders the payload issue block with the REAL assignee set across attach/replace/clear (the ToAPIIssue emission witness)", async () => {
    // The label notifiers render the payload issue through the SHARED
    // convert.ToAPIIssue on BOTH the attach/replace arm (notifier.go
    // IssueChangeLabels:598-604) and the clear arm (IssueClearLabels:74):
    // LoadAssignees, then every assignee into `assignees` with the first
    // duplicated into the deprecated `assignee` (services/convert/issue.go:
    // 105-112). emitLabelEvent rides that same folded render (the default
    // "wire" mode — the emission-align wave) — flipping the site back to the
    // landed emission-nulls shape must break here, never slip through
    // silently.
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("neighbor");
    const recluse = await seedUser("recluse");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "labeled-set");
    await db().insert(issueAssignees).values([
      { issueId: issue.id, assigneeId: neighbor.id },
      { issueId: issue.id, assigneeId: recluse.id },
    ]);
    const a = await seedLabel(repoId, "alpha");
    const b = await seedLabel(repoId, "beta");
    const hookId = await seedHook(repoId, ["issue_label"]);

    const add = await router()(`/repos/${owner.usernameLower}/visible/issues/${issue.index}/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [a, b] }),
    });
    expect(add.status).toBe(200);

    const replace = await router()(`/repos/${owner.usernameLower}/visible/issues/${issue.index}/labels`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ labels: [b] }),
    });
    expect(replace.status).toBe(200);

    const clear = await router()(`/repos/${owner.usernameLower}/visible/issues/${issue.index}/labels`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(clear.status).toBe(204);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_label", "issue_label", "issue_label"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["label_updated", "label_updated", "label_cleared"]);
    // Edge-row (insertion) order — the listIssueAssignees orderBy — with the
    // first assignee duplicated into `assignee` (ToIssue issue.go:105-113),
    // IDENTICALLY on attach, replace and clear: one shared converter, one
    // render.
    for (const delivery of deliveries) {
      const payload = JSON.parse(delivery.payloadContent) as {
        issue: { assignee: { login: string } | null; assignees: Array<{ login: string }> | null };
      };
      expect(payload.issue.assignees?.map((u) => u.login)).toEqual([neighbor.usernameLower, recluse.usernameLower]);
      expect(payload.issue.assignee).toMatchObject({ login: neighbor.usernameLower });
    }
  });

  it("stays silent for hooks not subscribed to issue_label", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    await seedIssue(repoId, "quiet");
    const hookId = await seedHook(repoId, ["issues"]); // sibling event, not issue_label

    const add = await router()("/repos/alice/visible/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(add.status).toBe(200);
    expect(await deliveriesFor(hookId)).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(0);
  });

  it("routes PR label writes to pull_request_label with the PullRequestPayload field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "approved");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR labels",
      posterId: 1,
    });
    const hookId = await seedHook(repoId, ["pull_request_label"]);

    const add = await router()(`/repos/alice/visible/issues/${pull.issue.index}/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(add.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_label");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 PullRequestPayload (hook.go:484) minus the null-only
    // requested_reviewer/review fields — the landed pulls.ts emission shape.
    expect(Object.keys(payload).sort()).toEqual(["action", "commit_id", "number", "pull_request", "repository", "sender"]);
    expect(payload.action).toBe("label_updated");
    expect(payload.number).toBe(pull.issue.index);
    expect((payload.pull_request as Record<string, unknown>).number).toBe(pull.pullRequest.index);
    expect((payload.pull_request as Record<string, unknown>).title).toBe("PR labels");
    // A pull_request_label-subscribed hook never sees issue_label traffic and
    // vice versa: the issue-arm event type would not match this config.
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(1);
  });

  it("renders the PR label payload's pull_request block with the REAL assignee set (ToPayloadPullRequest → ToAPIIssue LoadAssignees)", async () => {
    // Upstream's PR label payload is built by ToPayloadPullRequest (notifier.go
    // IssueChangeLabels:601-606), which feeds ToAPIIssue through it (pull.go:60)
    // — the real assignee set rides the payload too: Assignee keeps the first
    // duplicate and Assignees applies util.SliceNilAsEmpty (pull.go:86-87).
    // The emission-align wave dropped the payload-mode emission pin, so the
    // render is the real set — flipping back to the landed nulls must break
    // here.
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("neighbor");
    const recluse = await seedUser("recluse");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "approved");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR label assignees",
      posterId: 1,
    });
    await db().insert(issueAssignees).values([
      { issueId: pull.issue.id, assigneeId: neighbor.id },
      { issueId: pull.issue.id, assigneeId: recluse.id },
    ]);
    const hookId = await seedHook(repoId, ["pull_request_label"]);

    const add = await router()(`/repos/${owner.usernameLower}/visible/issues/${pull.issue.index}/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(add.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_label");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as {
      pull_request: { assignee: { login: string } | null; assignees: Array<{ login: string }> | null };
    };
    // Edge-row (insertion) order with the first assignee duplicated into the
    // deprecated `assignee` (ToIssue issue.go:105-113 through pull.go:86).
    expect(payload.pull_request.assignees?.map((u) => u.login)).toEqual([neighbor.usernameLower, recluse.usernameLower]);
    expect(payload.pull_request.assignee).toMatchObject({ login: neighbor.usernameLower });
  });

  it("renders the PR's EMPTY assignee set as [] not null (pull.go:87 SliceNilAsEmpty — the PR-converter nuance the issue arm lacks)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "approved");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR label empty assignees",
      posterId: 1,
    });
    const hookId = await seedHook(repoId, ["pull_request_label"]);

    const add = await router()(`/repos/${owner.usernameLower}/visible/issues/${pull.issue.index}/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(add.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    const payload = JSON.parse(deliveries[0]!.payloadContent) as {
      pull_request: { assignee: { login: string } | null; assignees: Array<{ login: string }> | null };
    };
    // SliceNilAsEmpty turns the nil slice into [] (pull.go:87) while the nil
    // `assignee` pointer stays null (pull.go:86) — the PR converter's shape,
    // NOT the issue arm's null/null.
    expect(payload.pull_request.assignees).toEqual([]);
    expect(payload.pull_request.assignee).toBeNull();
  });

  it("carries the diff-stat trio on the pull_request_label payload over the real range diff (the GetDiffShortStat block is not gated on isPayload — convert/pull.go:31-34 + :230-254)", async () => {
    // The namespace's owner ROW must exist — findRepositoryByPath inner-joins it.
    const owner = await seedUser("Alice");
    const { repoId, issueIndex } = await seedTrioPr(owner.usernameLower, "trio-label", "PR label trio");
    const labelId = await seedLabel(repoId, "approved");
    const hookId = await seedHook(repoId, ["pull_request_label"]);

    const add = await router()(`/repos/alice/trio-label/issues/${issueIndex}/labels`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(add.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_label");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as { pull_request: Record<string, unknown> };
    // README rewritten (1 add + 1 del) and notes.txt added (3 lines) — the
    // three-dot range main...refs/pull/N/head sums to 4/1/2 (the pulls.test.ts
    // GET pin's math); a D1-only PR omits the fields (the omit arm).
    expect(payload.pull_request).toMatchObject({ additions: 4, deletions: 1, changed_files: 2 });
  });
});

// ---------------------------------------------------------------------------
// Comment edit/delete webhook emissions (upstream services/webhook/notifier.go
// UpdateComment:420-461 — action=edited + changes.body.from — and
// DeleteComment:493-541 — action=deleted, no changes; the IsPull discriminant
// picks issue_comment vs pull_request_comment).
// ---------------------------------------------------------------------------

describe("comment edit/delete webhook emissions (issueEditComment / issueDeleteComment)", () => {
  it("emits issue_comment edited with changes.body.from on PATCH, deleted (no changes) on DELETE", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "commented");
    // Poster = the stub token identity (id 1) — the PATCH/DELETE doer must
    // pass the poster-or-writer gate.
    const comment = await service().addComment({ issueId: issue.id, posterId: 1, content: "first draft" });
    const hookId = await seedHook(repoId, ["issue_comment"]);

    const edit = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "second draft" }),
    });
    expect(edit.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("issue_comment");
    const edited = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 IssueCommentPayload (hook.go:297-314) minus the nullable
    // `pull_request` field — the landed created-emission shape + `changes`.
    expect(Object.keys(edited).sort()).toEqual(["action", "changes", "comment", "is_pull", "issue", "repository", "sender"]);
    expect(edited.action).toBe("edited");
    expect(edited.changes).toEqual({ body: { from: "first draft" } }); // the pre-edit content
    expect(edited.is_pull).toBe(false);
    expect(edited.comment).toMatchObject({ id: comment.id, body: "second draft" });
    expect(edited.repository).toMatchObject({ full_name: "alice/visible" });

    const del = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, { method: "DELETE", headers: authHeaders });
    expect(del.status).toBe(204);

    const after = await deliveriesFor(hookId);
    expect(after.map((d) => d.eventType)).toEqual(["issue_comment", "issue_comment"]);
    const deleted = JSON.parse(after[1]!.payloadContent) as Record<string, unknown>;
    expect(Object.keys(deleted).sort()).toEqual(["action", "comment", "is_pull", "issue", "repository", "sender"]); // no `changes`
    expect(deleted.action).toBe("deleted");
    expect(deleted.comment).toMatchObject({ id: comment.id, body: "second draft" }); // the pre-delete body
    expect(deleted.is_pull).toBe(false);
  });

  it("routes PR comment edits/deletes to pull_request_comment", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR comments",
      posterId: 1,
    });
    const comment = await service().addComment({ issueId: pull.issue.id, posterId: 1, content: "review note" });
    const hookId = await seedHook(repoId, ["pull_request_comment"]);
    const issuesHook = await seedHook(repoId, ["issue_comment"]);

    const edit = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "review note (edited)" }),
    });
    expect(edit.status).toBe(200);
    await router()(`/repos/alice/visible/issues/comments/${comment.id}`, { method: "DELETE", headers: authHeaders });

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["pull_request_comment", "pull_request_comment"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["edited", "deleted"]);
    const edited = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    expect(edited.is_pull).toBe(true);
    expect(edited.changes).toEqual({ body: { from: "review note" } });
    expect(edited.issue).toMatchObject({ number: pull.issue.index });
    // An issue_comment-subscribed hook never sees pull_request_comment traffic.
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
  });

  it("stays silent on an unchanged PATCH body, on system comments, and for unsubscribed hooks", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "quiet");
    // Poster = the stub token identity (id 1), so the PATCH passes the
    // poster-or-writer gate.
    const comment = await service().addComment({ issueId: issue.id, posterId: 1, content: "stable" });
    const hookId = await seedHook(repoId, ["issue_comment"]);
    const siblingHook = await seedHook(repoId, ["issues"]);

    // Upstream editIssueComment (issue_comment.go:569) notifies only when the
    // body actually changed.
    const noop = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "stable" }),
    });
    expect(noop.status).toBe(200);
    expect(await deliveriesFor(hookId)).toHaveLength(0);

    // System comments take the 204/400 early arms before any emission (the
    // stub identity is the close actor so the permission gate passes first).
    await service().closeIssue(issue.id, { actorId: 1 });
    const systemComment = (await db().select().from(comments).where(eq(comments.type, CommentType.Close)).all())[0];
    expect(systemComment).toBeDefined();

    const systemEdit = await router()(`/repos/alice/visible/issues/comments/${systemComment!.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "nope" }),
    });
    expect(systemEdit.status).toBe(204);
    const systemDelete = await router()(`/repos/alice/visible/issues/comments/${systemComment!.id}`, { method: "DELETE", headers: authHeaders });
    expect(systemDelete.status).toBe(400);
    expect(await deliveriesFor(hookId)).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(0);
    expect(await deliveriesFor(siblingHook)).toHaveLength(0);
  });

  it("renders the payload issue block with the REAL assignee set across created/edited (the ToAPIIssue emission witness)", async () => {
    // Upstream's comment notifiers render the payload issue through the SHARED
    // convert.ToAPIIssue on ALL THREE arms (CreateIssueComment:482,
    // UpdateComment:447, DeleteComment:523): LoadAssignees, then every
    // assignee into `assignees` with the first duplicated into the deprecated
    // `assignee` (services/convert/issue.go:105-112). The emission-align wave
    // dropped the route's null pins, so both emission sites (the POST route's
    // created payload and emitCommentEvent's edited/deleted payload) ride the
    // default wire render — flipping back to the landed nulls must break here.
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("neighbor");
    const recluse = await seedUser("recluse");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "commented-set");
    await db().insert(issueAssignees).values([
      { issueId: issue.id, assigneeId: neighbor.id },
      { issueId: issue.id, assigneeId: recluse.id },
    ]);
    const hookId = await seedHook(repoId, ["issue_comment"]);

    const created = await router()(`/repos/alice/visible/issues/${issue.index}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "a comment" }),
    });
    expect(created.status).toBe(201);
    const comment = await created.json<{ id: number }>();

    const edit = await router()(`/repos/alice/visible/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "edited comment" }),
    });
    expect(edit.status).toBe(200);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_comment", "issue_comment"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["created", "edited"]);
    // Edge-row (insertion) order — the listIssueAssignees orderBy — with the
    // first assignee duplicated into `assignee` (ToIssue issue.go:105-113),
    // IDENTICALLY on create and edit: one shared converter, one render.
    for (const delivery of deliveries) {
      const payload = JSON.parse(delivery.payloadContent) as {
        issue: { assignee: { login: string } | null; assignees: Array<{ login: string }> | null };
      };
      expect(payload.issue.assignees?.map((u) => u.login)).toEqual([neighbor.usernameLower, recluse.usernameLower]);
      expect(payload.issue.assignee).toMatchObject({ login: neighbor.usernameLower });
    }
  });
});

// ---------------------------------------------------------------------------
// issue_milestone / pull_request_milestone webhook emissions (upstream
// services/webhook/notifier.go IssueChangeMilestone:618-647 — the
// `issue.IsPull` discriminant picks the event type; action milestoned on a
// set and demilestoned on a clear, NO `changes` block).
// ---------------------------------------------------------------------------

describe("issue milestone webhook emissions (issueEditIssue PATCH milestone arm)", () => {
  it("emits milestoned on the set and demilestoned on the clear, with the IssuePayload field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const milestoneId = await seedMilestone(repoId, "v1");
    await seedIssue(repoId, "milestoned", { posterId: 1 });
    const hookId = await seedHook(repoId, ["issue_milestone"]);

    const set = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: milestoneId }),
    });
    expect(set.status).toBe(201);

    const clear = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: 0 }),
    });
    expect(clear.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_milestone", "issue_milestone"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["milestoned", "demilestoned"]);
    const setPayload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 IssuePayload (hook.go:435) — the milestone notifier sets NO `changes`.
    expect(Object.keys(setPayload).sort()).toEqual(["action", "commit_id", "issue", "number", "repository", "sender"]);
    expect(setPayload.number).toBe(1);
    expect((setPayload.issue as { milestone: { id: number } | null }).milestone?.id).toBe(milestoneId);
    // The unassigned issue's EMPTY assignee set renders the Go nils — `null`
    // for both fields (ToAPIIssue's len>0 gate), never [] — upstream's
    // IssueChangeMilestone:650 ToAPIIssue render for the same issue.
    const emptyIssue = setPayload.issue as { assignee: unknown; assignees: unknown };
    expect(emptyIssue.assignee).toBeNull();
    expect(emptyIssue.assignees).toBeNull();
    expect(setPayload.repository).toMatchObject({ full_name: "alice/visible" });
    expect(deliveries[1]!.payloadContent).toContain('\n  "action": "demilestoned"');
    expect((JSON.parse(deliveries[1]!.payloadContent) as { issue: { milestone: unknown } }).issue.milestone).toBeNull();
  });

  it("stays silent on an unchanged milestone PATCH, for push-only hooks, and for sibling subscriptions", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const milestoneId = await seedMilestone(repoId, "v1");
    await seedIssue(repoId, "quiet", { posterId: 1, milestoneId });
    const hookId = await seedHook(repoId, ["issue_milestone"]);
    const pushHook = await seedHook(repoId, ["push"]); // push_only-style selection
    const issuesHook = await seedHook(repoId, ["issues"]);

    // Same milestone again → upstream's `!=` guard skips the change entirely.
    const noop = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: milestoneId }),
    });
    expect(noop.status).toBe(201);
    expect(await deliveriesFor(hookId)).toHaveLength(0);
    expect(await deliveriesFor(pushHook)).toHaveLength(0);
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(0);
  });

  it("routes PR milestone writes to pull_request_milestone with the PullRequestPayload field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const milestoneId = await seedMilestone(repoId, "v1");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR milestone",
      posterId: 1,
    });
    const hookId = await seedHook(repoId, ["pull_request_milestone"]);
    const issuesHook = await seedHook(repoId, ["issue_milestone"]);

    const set = await router()(`/repos/alice/visible/issues/${pull.issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: milestoneId }),
    });
    expect(set.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_milestone");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 PullRequestPayload (hook.go:484) minus the null-only
    // requested_reviewer/review fields — the landed pulls.ts emission shape.
    expect(Object.keys(payload).sort()).toEqual(["action", "commit_id", "number", "pull_request", "repository", "sender"]);
    expect(payload.action).toBe("milestoned");
    expect(payload.number).toBe(pull.issue.index);
    expect((payload.pull_request as Record<string, unknown>).number).toBe(pull.pullRequest.index);
    // A pull_request_milestone-subscribed hook never sees issue_milestone
    // traffic and vice versa.
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(1);
  });

  it("renders the payload issue block with the REAL assignee set across milestoned/demilestoned (the ToAPIIssue emission witness)", async () => {
    // Upstream's milestone notifier renders the payload issue through the
    // SHARED convert.ToAPIIssue (IssueChangeMilestone:650): LoadAssignees,
    // then every assignee into `assignees` with the first duplicated into the
    // deprecated `assignee` (services/convert/issue.go:105-112). The
    // emission-align wave dropped the route's null pin, so the emission rides
    // the default wire render — flipping back to the landed nulls must break
    // here.
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("neighbor");
    const recluse = await seedUser("recluse");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const milestoneId = await seedMilestone(repoId, "v1");
    const issue = await seedIssue(repoId, "milestoned-set", { posterId: 1 });
    await db().insert(issueAssignees).values([
      { issueId: issue.id, assigneeId: neighbor.id },
      { issueId: issue.id, assigneeId: recluse.id },
    ]);
    const hookId = await seedHook(repoId, ["issue_milestone"]);

    const set = await router()(`/repos/alice/visible/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: milestoneId }),
    });
    expect(set.status).toBe(201);

    const clear = await router()(`/repos/alice/visible/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: 0 }),
    });
    expect(clear.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_milestone", "issue_milestone"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["milestoned", "demilestoned"]);
    // Edge-row (insertion) order — the listIssueAssignees orderBy — with the
    // first assignee duplicated into `assignee` (ToIssue issue.go:105-113),
    // IDENTICALLY on set and clear: one shared converter, one render.
    for (const delivery of deliveries) {
      const payload = JSON.parse(delivery.payloadContent) as {
        issue: { assignee: { login: string } | null; assignees: Array<{ login: string }> | null };
      };
      expect(payload.issue.assignees?.map((u) => u.login)).toEqual([neighbor.usernameLower, recluse.usernameLower]);
      expect(payload.issue.assignee).toMatchObject({ login: neighbor.usernameLower });
    }
  });

  it("carries the diff-stat trio on the pull_request_milestone payload over the real range diff (the GetDiffShortStat block is not gated on isPayload — convert/pull.go:31-34 + :230-254)", async () => {
    // The namespace's owner ROW must exist — findRepositoryByPath inner-joins it.
    const owner = await seedUser("Alice");
    const { repoId, issueIndex } = await seedTrioPr(owner.usernameLower, "trio-mile", "PR milestone trio");
    const milestoneId = await seedMilestone(repoId, "v1");
    const hookId = await seedHook(repoId, ["pull_request_milestone"]);

    const set = await router()(`/repos/alice/trio-mile/issues/${issueIndex}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ milestone: milestoneId }),
    });
    expect(set.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_milestone");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as { pull_request: Record<string, unknown> };
    // The seedTrioPr math: 4 adds / 1 del over 2 files.
    expect(payload.pull_request).toMatchObject({ additions: 4, deletions: 1, changed_files: 2 });
  });
});

// ---------------------------------------------------------------------------
// issue assign webhook emissions + the UpdateAssignees write path (PATCH
// /repos/{owner}/{repo}/issues/{index} assignee arm — upstream EditIssue →
// issue_service.UpdateAssignees, issue.go:772-779 → services/issue/
// assignee.go:94-166, shared with the pulls PATCH through the landed
// replaceIssueAssignees service; emissions per services/webhook/notifier.go
// IssueChangeAssignee:161-202 — ONE event per actually-changed assignee, the
// one-element changes.added_assignees/removed_assignees side, the IsPull
// discriminant picking issue_assign vs pull_request_assign).
// ---------------------------------------------------------------------------

describe("issue assign webhook emissions (issueEditIssue PATCH assignee arm)", () => {
  /** The stub-owned repo (the doer is the owner → the writer gate passes)
   *  with one stub-posted issue — the pulls.test.ts seed shape. */
  async function seedOwnedList(title: string): Promise<{ repoId: string; issueId: number; index: number }> {
    const repoId = await seedRepo("cf-gitea-stub", "visible");
    const issue = await seedIssue(repoId, title, { posterId: 1 });
    return { repoId, issueId: issue.id, index: issue.index };
  }

  it("emits one issue_assign assigned event per added assignee with changes.added_assignees and the POST-change issue render", async () => {
    const neighbor = await seedUser("neighbor");
    const recluse = await seedUser("recluse");
    const { repoId } = await seedOwnedList("assigned");
    const hookId = await seedHook(repoId, ["issue_assign"]);

    const res = await router()("/repos/cf-gitea-stub/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [neighbor.usernameLower, recluse.usernameLower] }),
    });
    expect(res.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_assign", "issue_assign"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["assigned", "assigned"]);
    const first = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 IssuePayload (hook.go:435) + the ChangesPayload assignee side.
    expect(Object.keys(first).sort()).toEqual(["action", "changes", "commit_id", "issue", "number", "repository", "sender"]);
    expect(first.number).toBe(1);
    // The changed side only (ChangesPayload.assignees lists are omitempty)
    // with the one assignee rendered as the §2.7 User object.
    expect(Object.keys(first.changes as object).sort()).toEqual(["added_assignees"]);
    const firstChanges = first.changes as { added_assignees: Array<Record<string, unknown>> };
    expect(firstChanges.added_assignees).toHaveLength(1);
    expect(firstChanges.added_assignees[0]).toMatchObject({ login: neighbor.usernameLower });
    expect(first.commit_id).toBe("");
    expect(first.sender).toMatchObject({ login: "cf-gitea-stub" });
    expect(first.repository).toMatchObject({ full_name: "cf-gitea-stub/visible" });
    // The payload issue renders the POST-change assignee set (upstream
    // ToAPIIssue LoadAssignees) through the enriched overlay.
    const second = JSON.parse(deliveries[1]!.payloadContent) as {
      changes: { added_assignees: Array<{ login: string }> };
      issue: { assignees: Array<{ login: string }> | null };
    };
    expect(second.changes.added_assignees.map((u) => u.login)).toEqual([recluse.usernameLower]);
    expect(second.issue.assignees?.map((u) => u.login)).toEqual([neighbor.usernameLower, recluse.usernameLower]);
  });

  it("replaces the set: the unrequested assignee is removed (removal notifies FIRST) with changes.removed_assignees, then the add", async () => {
    const dana = await seedUser("dana");
    const bob = await seedUser("bob");
    const { repoId, issueId } = await seedOwnedList("replaced");
    await db().insert(issueAssignees).values({ issueId, assigneeId: bob.id });
    const hookId = await seedHook(repoId, ["issue_assign"]);

    const res = await router()("/repos/cf-gitea-stub/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [dana.usernameLower] }),
    });
    expect(res.status).toBe(201);

    // Upstream's post-tx notify order: removals before adds
    // (assignee.go:155-166).
    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_assign", "issue_assign"]);
    const actions = deliveries.map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["unassigned", "assigned"]);
    const removed = JSON.parse(deliveries[0]!.payloadContent) as { changes: { removed_assignees: Array<{ login: string }> } };
    expect(Object.keys(removed.changes as object).sort()).toEqual(["removed_assignees"]);
    expect(removed.changes.removed_assignees.map((u) => u.login)).toEqual([bob.usernameLower]);
    const added = JSON.parse(deliveries[1]!.payloadContent) as { changes: { added_assignees: Array<{ login: string }> } };
    expect(added.changes.added_assignees.map((u) => u.login)).toEqual([dana.usernameLower]);

    // One type-9 toggle comment per changed assignee; the edge set is the
    // requested one.
    const edges = await db().select().from(issueAssignees).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.assigneeId).toBe(dana.id);
    const toggles = await db().select().from(comments).all();
    expect(toggles).toHaveLength(2);
    expect(toggles.map((t) => t.type)).toEqual([CommentType.Assignees, CommentType.Assignees]);
    expect(toggles.map((t) => t.removedAssignee)).toEqual([1, 0]);
  });

  it("stays silent when the PATCH names the unchanged set — no removals, every add skipped, no comment, no notification (UpdateAssignees no-op)", async () => {
    const neighbor = await seedUser("neighbor");
    const { repoId, issueId } = await seedOwnedList("quiet");
    await db().insert(issueAssignees).values({ issueId, assigneeId: neighbor.id });
    const hookId = await seedHook(repoId, ["issue_assign"]);
    const pushHook = await seedHook(repoId, ["push"]); // push-only-style selection
    const issuesHook = await seedHook(repoId, ["issues"]);

    const res = await router()("/repos/cf-gitea-stub/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [neighbor.usernameLower] }),
    });
    expect(res.status).toBe(201);
    // AddAssigneeIfNotAssigned's already-assigned skip (assignee.go:186-204):
    // the edge row stands untouched, nothing else is written or fired.
    expect(await deliveriesFor(hookId)).toHaveLength(0);
    expect(await deliveriesFor(pushHook)).toHaveLength(0);
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(0);
    expect(await db().select().from(issueAssignees).all()).toHaveLength(1);
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("403s \"user is blocked\" before ANY write when the doer is blocked by a requested assignee (the pre-write validateAssignee loop)", async () => {
    const neighbor = await seedUser("neighbor");
    const { repoId } = await seedOwnedList("blocked");
    const hookId = await seedHook(repoId, ["issue_assign"]);
    await db().insert(userBlocking).values({ blockerId: neighbor.id, blockeeId: 1, note: "", createdAt: new Date() });

    const res = await router()("/repos/cf-gitea-stub/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [neighbor.usernameLower] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await db().select().from(issueAssignees).all()).toHaveLength(0);
    expect(await db().select().from(comments).all()).toHaveLength(0);
    expect(await deliveriesFor(hookId)).toHaveLength(0);
  });

  it("422s an unknown assignee name with the pulls-PATCH mapping's wrapper message (documented divergence from issue.go:780-783's 500)", async () => {
    await seedOwnedList("ghosted");

    const res = await router()("/repos/cf-gitea-stub/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["ghost"] }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: "Assignee does not exist: [name: user does not exist [uid: 0, name: ghost]]",
      url: ERROR_URL,
    });
  });

  it("an empty array clears the set (the upstream [] clear arm) and notifies the one removal", async () => {
    const bob = await seedUser("bob");
    const { repoId, issueId } = await seedOwnedList("cleared");
    await db().insert(issueAssignees).values({ issueId, assigneeId: bob.id });
    const hookId = await seedHook(repoId, ["issue_assign"]);

    const res = await router()("/repos/cf-gitea-stub/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [] }),
    });
    expect(res.status).toBe(201);
    expect(await db().select().from(issueAssignees).all()).toHaveLength(0);
    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((d) => d.eventType)).toEqual(["issue_assign"]);
    expect((JSON.parse(deliveries[0]!.payloadContent) as { action: string }).action).toBe("unassigned");
  });

  it("the arm sits inside the writer gate — a POSTER without write access PATCHes fine but the assignee fields are ignored (upstream's canWrite arm, issue.go:772)", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("neighbor");
    // The STUB is the poster here, on alice's public repo — poster-or-writer
    // lets the PATCH through, but the stub holds no write grant on it.
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "poster-gated", { posterId: 1 });
    const hookId = await seedHook(repoId, ["issue_assign"]);

    const res = await router()("/repos/alice/visible/issues/1", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [neighbor.usernameLower], title: "poster can retitle" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe("poster can retitle");
    expect(await db().select().from(issueAssignees).all()).toHaveLength(0);
    // The title edit's type-10 comment stands; NO type-9 assignee toggle.
    expect(
      await db().select().from(comments).where(eq(comments.type, CommentType.Assignees)).all(),
    ).toHaveLength(0);
    expect(await deliveriesFor(hookId)).toHaveLength(0);
  });

  it("routes PR assignee writes to pull_request_assign with the PullRequestPayload field set", async () => {
    const neighbor = await seedUser("neighbor");
    const { repoId } = await seedOwnedList("pr-assigned");
    const pull = await service().createPullRequest({
      repoId,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      title: "PR assignees",
      posterId: 1,
    });
    const hookId = await seedHook(repoId, ["pull_request_assign"]);
    const issuesHook = await seedHook(repoId, ["issue_assign"]);

    const res = await router()(`/repos/cf-gitea-stub/visible/issues/${pull.issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [neighbor.usernameLower] }),
    });
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
    expect((payload.changes as { added_assignees: Array<{ login: string }> }).added_assignees.map((u) => u.login)).toEqual([neighbor.usernameLower]);
    expect((payload.pull_request as Record<string, unknown>).title).toBe("PR assignees");
    // A pull_request_assign-subscribed hook never sees issue_assign traffic.
    expect(await deliveriesFor(issuesHook)).toHaveLength(0);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(1);
  });

  it("carries the diff-stat trio on the pull_request_assign payload over the real range diff (the GetDiffShortStat block is not gated on isPayload — convert/pull.go:31-34 + :230-254)", async () => {
    // The stub-owned repo (the doer is the owner → the assignee writer gate
    // passes — seedOwnedList's posture).
    const neighbor = await seedUser("neighbor");
    const { repoId, issueIndex } = await seedTrioPr("cf-gitea-stub", "trio-assign", "PR assign trio");
    const hookId = await seedHook(repoId, ["pull_request_assign"]);

    const res = await router()(`/repos/cf-gitea-stub/trio-assign/issues/${issueIndex}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [neighbor.usernameLower] }),
    });
    expect(res.status).toBe(201);

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request_assign");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as { pull_request: Record<string, unknown> };
    // The seedTrioPr math: 4 adds / 1 del over 2 files.
    expect(payload.pull_request).toMatchObject({ additions: 4, deletions: 1, changed_files: 2 });
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

  it("wires the mention filters — mentioned (doer), mentioned_by (other) with visibility, the empty set", async () => {
    const owner = await seedUser("Alice");
    const neighbor = await seedUser("Bob");
    const publicRepo = await seedRepo(owner.usernameLower, "mention-public");
    const privateRepo = await seedRepo(owner.usernameLower, "mention-private", { private: true });
    const stubMentioned = await seedIssue(publicRepo, "stub mentioned here", { posterId: owner.id });
    const bobPublic = await seedIssue(publicRepo, "bob mentioned here", { posterId: owner.id });
    const bobPrivate = await seedIssue(privateRepo, "bob mentioned privately", { posterId: owner.id });
    await seedIssue(publicRepo, "no mentions", { posterId: owner.id });
    const stubId = STUB_USER.id;
    if (stubId === undefined) throw new Error("stub identity carries no id");
    // The carrier rows (uid = the MENTIONED user): the stub doer on the
    // public thread, bob on one public and one PRIVATE thread.
    await db().insert(issueUsers).values([
      { userId: stubId, issueId: stubMentioned.id, isMentioned: true },
      { userId: neighbor.id, issueId: bobPublic.id, isMentioned: true },
      { userId: neighbor.id, issueId: bobPrivate.id, isMentioned: true },
    ]);

    // mentioned-by-me: the signed doer-flag (repo/issue.go:223-225, gated
    // on IsSigned) rides the carrier rows — applyMentionedCondition.
    const me = await router()("/repos/issues/search?mentioned=true", { headers: { Authorization: `token ${TOKEN}` } });
    expect(me.status).toBe(200);
    expect(me.headers.get("X-Total-Count")).toBe("1");
    expect((await me.json<{ title: string }[]>())[0]?.title).toBe("stub mentioned here");

    // Anonymous callers keep NO mention filter (upstream ignores the flag
    // when unsigned) — the full visible set answers.
    const anonFlag = await router()("/repos/issues/search?mentioned=true");
    expect(anonFlag.headers.get("X-Total-Count")).toBe("3");

    // mentioned-by-other with visibility: bob's mention condition ANDs the
    // visible-repo set, so the anonymous/stub viewer sees only the PUBLIC
    // mention — the private thread's mention row never leaks the repo.
    const bobAsOthers = await router()("/repos/issues/search?mentioned_by=BOB");
    expect(bobAsOthers.status).toBe(200);
    expect(bobAsOthers.headers.get("X-Total-Count")).toBe("1");
    expect((await bobAsOthers.json<{ title: string }[]>())[0]?.title).toBe("bob mentioned here");

    // The admin viewer reads every repo, so the same filter surfaces the
    // private mention too (the condition is repo-set-relative, never a
    // hard public-only gate — that posture is UserMentionedRepoCond's, a
    // web-dashboard arm this backend does not carry).
    const adminApp = createApiRouter({ auth: { resolveToken: () => Promise.resolve({ ...STUB_USER, is_admin: true }) } });
    const bobAsAdmin = await adminApp.fetch(
      new Request("https://example.com/repos/issues/search?mentioned_by=bob", { headers: authHeaders }),
      env,
    );
    expect(bobAsAdmin.headers.get("X-Total-Count")).toBe("2");

    // The empty-set arm: a resolved user with no mention rows.
    const emptySet = await router()("/repos/issues/search?mentioned_by=alice");
    expect(emptySet.status).toBe(200);
    expect(emptySet.headers.get("X-Total-Count")).toBe("0");
  });

  it("400s unknown owners and owner-less team filters; 422s bad time formats", async () => {
    await seedUser("Alice");

    const unknownOwner = await router()("/repos/issues/search?owner=ghost");
    expect(unknownOwner.status).toBe(400); // SearchIssues maps ErrNotExist → 400
    expect(await unknownOwner.json()).toEqual({ message: "user does not exist [uid: 0, name: ghost]", url: ERROR_URL });

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

// ---------------------------------------------------------------------------
// Blocked-user enforcement (the wave-blocks-enforcement arms) — the upstream
// 403 "user is blocked" writes (ErrBlockedUser, models/user/block.go:21,
 // answered via APIErrorAuto's permission-denied unwrap). Cites per case.
// ---------------------------------------------------------------------------

describe("blocked-user enforcement (ErrBlockedUser arms)", () => {
  /** A repo whose owner row exists and carries ownerId (the blocked arm
   *  probes user_blocking against it). */
  async function seedOwnedRepo(owner: { id: number; usernameLower: string }): Promise<string> {
    const id = String(repoSeq++);
    await db().insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "blocked",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date("2026-02-03T04:05:06Z"),
    });
    await service().ensureRepoCounters(id);
    return id;
  }

  async function seedBlock(blockerId: number, blockeeId: number): Promise<void> {
    await db().insert(userBlocking).values({ blockerId, blockeeId, note: "", createdAt: new Date() });
  }

  /** The site-admin identity router (the bypass cases — STUB_USER is frozen
   *  at is_admin: false, so the default router cannot reach the arm). */
  const adminRouter = () => {
    const app = createApiRouter({
      auth: { resolveToken: () => Promise.resolve({ ...STUB_USER, is_admin: true }) },
    });
    return async (path: string, init?: RequestInit): Promise<Response> =>
      app.fetch(new Request(`https://example.com${path}`, init), env);
  };

  it("POST /issues: a doer blocked by the repo owner answers 403 user is blocked (issue.go:625 → services/issue/issue.go:33-34)", async () => {
    const owner = await seedUser("Alice");
    await seedOwnedRepo(owner);
    await seedBlock(owner.id, 1); // the repo owner blocks the stub doer

    const res = await router()(`/repos/Alice/blocked/issues`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "opened while blocked" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
  });

  it("POST /issues: a site-admin doer bypasses the block (IsUserBlockedBy's IsAdmin arm, block.go:42-44)", async () => {
    const owner = await seedUser("Alice");
    await seedOwnedRepo(owner);
    await seedBlock(owner.id, 1);

    const res = await adminRouter()(`/repos/Alice/blocked/issues`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "opened by the site admin" }),
    });
    expect(res.status).toBe(201);
  });

  it("PATCH /issues/{index}: a blocked poster cannot change the title or body (issue.go:104-106, content.go:21-23 via issue.go:780's EditIssue)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedOwnedRepo(owner);
    const issue = await seedIssue(repoId, "authored before the block", { posterId: 1, content: "original body" });
    await seedBlock(owner.id, 1);

    const title = await router()(`/repos/Alice/blocked/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "retitled while blocked" }),
    });
    expect(title.status).toBe(403);
    expect(await title.json()).toEqual({ message: "user is blocked", url: ERROR_URL });

    const body = await router()(`/repos/Alice/blocked/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "edited while blocked" }),
    });
    expect(body.status).toBe(403);
    expect(await body.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
  });

  it("PATCH /issues/{index}: an unchanged title skips the arm (upstream guards UpdateIssue on actual change)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedOwnedRepo(owner);
    const issue = await seedIssue(repoId, "same title", { posterId: 1 });
    await seedBlock(owner.id, 1);

    const res = await router()(`/repos/Alice/blocked/issues/${issue.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "same title" }),
    });
    expect(res.status).toBe(201);
  });

  it("POST comments: a doer blocked by the repo owner answers 403 (issue_comment.go:387 → services/issue/comments.go:63-65)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedOwnedRepo(owner);
    const issue = await seedIssue(repoId, "comment target", { posterId: owner.id });
    await seedBlock(owner.id, 1);

    const res = await router()(`/repos/Alice/blocked/issues/${issue.index}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "commenting while blocked" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
  });

  it("POST comments: a repo-admin doer bypasses (IsUserRepoAdmin, repo_permission.go:532)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedOwnedRepo(owner);
    const issue = await seedIssue(repoId, "comment target", { posterId: owner.id });
    await seedBlock(owner.id, 1);
    await db().insert(repoCollaborators).values({ repoId, userId: 1, mode: "admin", createdAt: new Date() });

    const res = await router()(`/repos/Alice/blocked/issues/${issue.index}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ body: "repo admins comment through blocks" }),
    });
    expect(res.status).toBe(201);
  });

  it("PATCH comments/{id}: a blocked doer cannot edit (issue_comment.go:574 → services/issue/comments.go:106-108)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedOwnedRepo(owner);
    const issue = await seedIssue(repoId, "comment target", { posterId: owner.id });
    const comment = await service().addComment({ issueId: issue.id, posterId: 1, content: "mine first" });
    await seedBlock(owner.id, 1);

    const res = await router()(`/repos/Alice/blocked/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ body: "edited while blocked" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
  });
});

// ---------------------------------------------------------------------------
// Query-shape witness (docs/research/query-shape-audit.md A2) — the issues
// list used to pay one poster/label/pin (plus milestone/PR-row when set)
// select PER ROW; the page now prefetches one inArray read per entity kind
// and renders through toApiIssue's optional preload. Same metering pattern
// as bench-d1.test.ts's wrapper, route-level: a prepare()-counting D1
// wrapper rides app.fetch's env parameter (the routes read c.env.DB), so
// the counter is the request's exact D1 roundtrip count.
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

describe("issues list query-shape witness (query-shape-audit A2)", () => {
  it("renders the page with a constant statement count, deep-equal to the per-row single GETs", async () => {
    const owner = await seedUser("Alice");
    const other = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const bug = await seedLabel(repoId, "bug");
    const ui = await seedLabel(repoId, "ui");
    const v1 = await seedMilestone(repoId, "v1");
    // Every enrichment shape on one page: two posters, two labels (second
    // issue attaches them REVERSED — render order is label-id order either
    // way), a real milestone, a dangling milestone id (the audit's deleted
    // edge → null), a closed row, a pin, one PR row, and the assignee arms —
    // a MULTI-assignee set on the first issue (edges inserted REVERSED to the
    // user-id order: the render is edge-row/insertion order, never id order)
    // and an EMPTY set on the second (the upstream nulls).
    const first = await seedIssue(repoId, "labeled milestone", { posterId: owner.id, labelIds: [bug, ui], milestoneId: v1 });
    const second = await seedIssue(repoId, "labeled reversed", { posterId: other.id, labelIds: [ui, bug] });
    await db().insert(issueAssignees).values([
      { issueId: first.id, assigneeId: other.id },
      { issueId: first.id, assigneeId: owner.id },
    ]);
    await seedIssue(repoId, "plain", { posterId: owner.id });
    const dangling = await seedIssue(repoId, "dangling milestone", { posterId: other.id });
    await db().update(issues).set({ milestoneId: 999999 }).where(eq(issues.id, dangling.id));
    await seedIssue(repoId, "closed one", { posterId: owner.id, closed: true });
    const pr = await service().createPullRequest({
      repoId,
      title: "the PR",
      posterId: other.id,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "feature",
    });
    await db().insert(issuePins).values({ issueId: first.id, repoId, pinOrder: 2 });

    const app = createApiRouter();
    const meter = countedD1();
    const listRes = await app.fetch(new Request("https://example.com/repos/Alice/visible/issues?state=all"), {
      ...env,
      DB: meter.db,
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json<
      Array<Record<string, unknown> & { number: number; labels: Array<{ name: string }>; pull_request: unknown; assignee: { login: string } | null; assignees: Array<{ login: string }> | null }>
    >();
    expect(list).toHaveLength(6);
    const count = meter.count();
    // Post-fix: 1 repo resolve + the unit-gate read (the mustEnableIssuesOrPulls
    // mount — one constant loadRepoSettings per request, not per row; it rides
    // the shared settings+units loader) + 2 (count + page) + 6 prefetch arms
    // (posters, labels, pins, milestones, PR rows, assignees) —
    // page-INDEPENDENT (the assignees arm is ONE join read for the whole
    // page, the fold's added arm). The pre-fix shape (audit formula
    // 2 + N×3..5) paid 1 + 2 + 6×3 + 2 milestones + 1 PR row = 24 at this N;
    // the bounds below fail if any per-row fan returns (each issue's 3 reads
    // alone would exceed it).
    expect(count).toBeLessThanOrEqual(11);
    expect(count).toBeLessThan(6 * 3);

    // The folded assignee block: the multi set renders in edge-row (insertion)
    // order with the FIRST edge duplicated into the deprecated `assignee`
    // (convert.ToIssue issue.go:105-113); the empty set renders the upstream
    // nulls — never [].
    const multi = list.find((item) => item.number === first.index);
    expect(multi?.assignees?.map((u) => u.login)).toEqual(["Bob", "Alice"]);
    expect(multi?.assignee?.login).toBe("Bob");
    expect(list.find((item) => item.number === second.index)?.assignees).toBeNull();
    expect(list.find((item) => item.number === second.index)?.assignee).toBeNull();

    // Contract discipline: the batched list render must be deep-equal to the
    // per-row single-GET renders (the unbatched path) for every row —
    // covers the null poster, the dangling-milestone null, pin_order, the
    // PR meta block, the label ordering, and BOTH assignee arms (multi +
    // empty) in one sweep.
    for (let index = 1; index <= 6; index++) {
      const singleRes = await app.fetch(new Request(`https://example.com/repos/Alice/visible/issues/${index}`), env);
      expect(singleRes.status).toBe(200);
      const single = await singleRes.json<Record<string, unknown>>();
      expect(single).toEqual(list.find((item) => item.number === index));
    }
    expect(list.find((item) => item.number === pr.issue.index)?.pull_request).not.toBeNull();
    expect(list.find((item) => item.number === second.index)?.labels.map((l: { name: string }) => l.name)).toEqual(["bug", "ui"]);
  });

  // The fold's dynamic arms, route-level: a PATCH assignee replace must show
  // the POST-change set on the response body AND agree between the batched
  // list render and the per-row single GETs — multi, then the [] clear (the
  // upstream empty-set nulls).
  it("renders the POST-change set deep-equal across list and single GETs after a PATCH assignee replace", async () => {
    const one = await seedUser("assign-one");
    const two = await seedUser("assign-two");
    const repoId = await seedRepo("cf-gitea-stub", "visible");
    const seeded = await seedIssue(repoId, "assignee page", { posterId: 1 });
    await db().insert(issueAssignees).values({ issueId: seeded.id, assigneeId: one.id });

    const app = createApiRouter();
    const patch = (body: Record<string, unknown>) =>
      app.fetch(new Request("https://example.com/repos/cf-gitea-stub/visible/issues/1", {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(body),
      }), env);
    const listAndSingle = async () => {
      const list = await (await app.fetch(new Request("https://example.com/repos/cf-gitea-stub/visible/issues?state=all"), env)).json<
        Array<{ number: number; assignee: { login: string } | null; assignees: Array<{ login: string }> | null }>
      >();
      const single = await (await app.fetch(new Request("https://example.com/repos/cf-gitea-stub/visible/issues/1"), env)).json<
        Record<string, unknown>
      >();
      return { list, single };
    };

    // The replace: one survivor dropped, two names in — the response body and
    // both render paths carry the POST-change set (upstream EditIssue →
    // ToAPIIssue LoadAssignees).
    const replaceRes = await patch({ assignees: [two.usernameLower] });
    expect(replaceRes.status).toBe(201);
    const replaced = await replaceRes.json<{ assignee: { login: string } | null; assignees: Array<{ login: string }> | null }>();
    expect(replaced.assignees?.map((u) => u.login)).toEqual([two.usernameLower]);
    expect(replaced.assignee?.login).toBe(two.usernameLower);
    const replacedViews = await listAndSingle();
    expect(replacedViews.single).toEqual(replacedViews.list.find((item) => item.number === seeded.index));
    expect(replacedViews.list.find((item) => item.number === seeded.index)?.assignees?.map((u) => u.login)).toEqual([two.usernameLower]);

    // The [] clear: BOTH fields drop to the upstream nulls on every path.
    const clearRes = await patch({ assignees: [] });
    expect(clearRes.status).toBe(201);
    const cleared = await clearRes.json<{ assignee: unknown; assignees: unknown }>();
    expect(cleared.assignee).toBeNull();
    expect(cleared.assignees).toBeNull();
    const clearedViews = await listAndSingle();
    expect(clearedViews.single).toEqual(clearedViews.list.find((item) => item.number === seeded.index));
    expect(clearedViews.list.find((item) => item.number === seeded.index)?.assignee).toBeNull();
    expect(clearedViews.list.find((item) => item.number === seeded.index)?.assignees).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Query-shape witness (docs/research/query-shape-audit.md A7) — the comment
// lists used to pay ONE poster select PER COMMENT (toApiComment's toPoster);
// both list routes now prefetch one inArray read for the page's distinct
// posters and render through toApiComment's optional preload. The tier-2
// adoption of the M-grade batching, same metering pattern as the A2 witness
// above.
// ---------------------------------------------------------------------------

describe("comment list query-shape witness (query-shape-audit A7)", () => {
  it("renders both comment lists with a constant statement count, deep-equal to the per-row single GETs", async () => {
    const owner = await seedUser("Alice");
    const other = await seedUser("Bob");
    const third = await seedUser("Carol");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "thread", { posterId: owner.id });
    const second = await seedIssue(repoId, "other thread", { posterId: other.id });
    // Eight comment rows across THREE distinct posters spanning TWO issues,
    // plus one NULL-poster row (the audit's anonymous-system arm — the map
    // miss must render the per-row null user verbatim).
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "first" });
    await service().addComment({ issueId: issue.id, posterId: other.id, content: "second" });
    await service().addComment({ issueId: issue.id, posterId: third.id, content: "third" });
    await service().addComment({ issueId: issue.id, posterId: owner.id, content: "third-b" }); // poster dedupe
    await service().addComment({ issueId: issue.id, posterId: third.id, content: "third-c" }); // poster dedupe
    await service().addComment({ issueId: second.id, posterId: owner.id, content: "fourth" });
    await service().addComment({ issueId: second.id, posterId: third.id, content: "fifth" });
    await db()
      .insert(comments)
      .values({ type: CommentType.Comment, posterId: null, issueId: issue.id, content: "ghost", createdAt: new Date(), updatedAt: new Date() });

    const app = createApiRouter();

    // (a) The issue-scoped thread: 1 repo resolve + the unit-gate read (the
    // shared settings+units loader, one constant per request) + 1 issue
    // lookup + 1 page + 1 poster batch — page-INDEPENDENT (5 distinct
    // posters dedupe to one read). The pre-fix shape paid 3 + C×1 (C=6
    // here); the 6 per-comment posters alone would break the bound.
    const threadMeter = countedD1();
    const threadRes = await app.fetch(new Request(`https://example.com/repos/alice/visible/issues/${issue.index}/comments`), {
      ...env,
      DB: threadMeter.db,
    });
    expect(threadRes.status).toBe(200);
    const thread = await threadRes.json<Array<Record<string, unknown> & { id: number; user: unknown }>>();
    expect(thread).toHaveLength(6); // the null-poster row renders too
    const threadCount = threadMeter.count();
    expect(threadCount).toBeLessThanOrEqual(6);
    expect(threadCount).toBeLessThan(7); // 6 per-comment posters alone exceed it

    // (b) The repo-wide feed: 1 repo resolve + the unit-gate read + 2 (count
    // + page) + 1 poster batch (pre-fix 3 + C×1 = 11 at C=8).
    const feedMeter = countedD1();
    const feedRes = await app.fetch(new Request("https://example.com/repos/alice/visible/issues/comments?state=all"), {
      ...env,
      DB: feedMeter.db,
    });
    expect(feedRes.status).toBe(200);
    const feed = await feedRes.json<Array<Record<string, unknown> & { id: number; user: unknown }>>();
    expect(feed).toHaveLength(8);
    const feedCount = feedMeter.count();
    expect(feedCount).toBeLessThanOrEqual(6);
    expect(feedCount).toBeLessThan(8); // 8 per-comment posters alone exceed it

    // Contract discipline: every batched render is deep-equal to the
    // per-row single-GET render (the unbatched path) — covers the batched
    // poster map hits AND the null-poster miss in one sweep.
    for (const item of thread) {
      const singleRes = await app.fetch(new Request(`https://example.com/repos/alice/visible/issues/comments/${item.id}`), env);
      expect(singleRes.status).toBe(200);
      expect(await singleRes.json<Record<string, unknown>>()).toEqual(item);
    }
    for (const item of feed) {
      const singleRes = await app.fetch(new Request(`https://example.com/repos/alice/visible/issues/comments/${item.id}`), env);
      expect(singleRes.status).toBe(200);
      expect(await singleRes.json<Record<string, unknown>>()).toEqual(item);
    }
    expect(thread.find((item) => item.body === "ghost")?.user).toBeNull();
    expect(thread.filter((item) => item.user !== null)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Query-shape witness (docs/research/query-shape-audit.md A5, tier-2
// follow-up) — the timeline rendered each row with 1..5 SERIAL selects (the
// poster plus the timeline's own entity kinds the issue-list context does
// not carry: old/new milestone, the per-comment label, the assignee). The
// page now prefetches ONE inArray read per entity kind
// (prefetchTimelineContext) and renders through toTimelineComment's optional
// preload; the per-row fallback stays intact for omitted-preload callers —
// metered side by side below on the SAME rows and viewer.
// ---------------------------------------------------------------------------

describe("timeline query-shape witness (query-shape-audit A5)", () => {
  it("renders the page with a constant statement count, deep-equal to the per-row fallback renders", async () => {
    const owner = await seedUser("Alice");
    const other = await seedUser("Bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const issue = await seedIssue(repoId, "timeline meter", { posterId: owner.id });
    const empty = await seedIssue(repoId, "empty timeline", { posterId: owner.id });
    const bug = await seedLabel(repoId, "bug");
    const v1 = await seedMilestone(repoId, "v1");
    const v2 = await seedMilestone(repoId, "v2");
    const now = new Date();
    const insert = (values: Omit<typeof comments.$inferInsert, "issueId">) =>
      db().insert(comments).values({ issueId: issue.id, content: "", createdAt: now, updatedAt: now, ...values });

    // Every timeline row kind + every null/missing arm — 14 seeded rows, 13
    // rendered (the Code row is dropped): plain comments across two posters
    // (one deduped), change_title, a label on a real AND a dangling id, a
    // milestone change old→new AND a dangling old, an assignee real AND
    // dangling, a NULL-poster system close, a reopen, a commit_ref.
    await insert({ type: CommentType.Comment, posterId: owner.id, content: "note one" });
    await insert({ type: CommentType.Comment, posterId: other.id, content: "note two" });
    await insert({ type: CommentType.Comment, posterId: owner.id, content: "note three" }); // poster dedupe
    await insert({ type: CommentType.ChangeTitle, posterId: owner.id, oldTitle: "a", newTitle: "b" });
    await insert({ type: CommentType.Label, posterId: other.id, labelId: bug });
    await insert({ type: CommentType.Label, posterId: other.id, labelId: 999999 }); // dangling label → null
    await insert({ type: CommentType.Milestone, posterId: owner.id, oldMilestoneId: v1, milestoneId: v2 });
    await insert({ type: CommentType.Milestone, posterId: owner.id, oldMilestoneId: 999999 }); // dangling old → null
    await insert({ type: CommentType.Assignees, posterId: other.id, assigneeId: other.id, removedAssignee: 0 });
    await insert({ type: CommentType.Assignees, posterId: other.id, assigneeId: 999999 }); // dangling assignee → null
    await insert({ type: CommentType.Close, posterId: null }); // the null-poster arm
    await insert({ type: CommentType.Reopen, posterId: owner.id });
    await insert({ type: CommentType.CommitRef, posterId: other.id, commitSha: "abc123", refAction: 1 });
    await insert({ type: CommentType.Code, posterId: owner.id, content: "dropped" });

    const app = createApiRouter();

    // Batched route: 1 repo resolve + 1 issue lookup + 1 page + 4 prefetch
    // arms (posters, milestones, labels, assignees) = 7 — page-INDEPENDENT.
    // The pre-fix shape (audit formula: fixed prefix + R×(1..5)) pays
    // 3 + 19 = 22 at this N (12 poster selects + 7 metadata — the dangling
    // ids still paid their per-row select); both bounds fail if any per-row
    // fan returns.
    const meter = countedD1();
    const res = await app.fetch(new Request(`https://example.com/repos/alice/visible/issues/${issue.index}/timeline`), {
      ...env,
      DB: meter.db,
    });
    expect(res.status).toBe(200);
    const timeline = await res.json<Array<Record<string, unknown> & { type: string; user: unknown }>>();
    expect(timeline).toHaveLength(13);
    expect(timeline.map((item) => item.type)).toEqual([
      "comment",
      "comment",
      "comment",
      "change_title",
      "label",
      "label",
      "milestone",
      "milestone",
      "assignees",
      "assignees",
      "close",
      "reopen",
      "commit_ref",
    ]);
    const count = meter.count();
    expect(count).toBeLessThanOrEqual(9); // + the unit-gate read (constant)
    expect(count).toBeLessThan(12); // the 12 per-row posters alone exceed it

    // Empty-skip discipline: a page with NO rows skips every prefetch arm —
    // exactly the fixed prefix (repo resolve + the unit-gate read, the same
    // fixed cost the per-row path paid on an empty page).
    const emptyMeter = countedD1();
    const emptyRes = await app.fetch(new Request(`https://example.com/repos/alice/visible/issues/${empty.index}/timeline`), {
      ...env,
      DB: emptyMeter.db,
    });
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json<unknown[]>()).toEqual([]);
    expect(emptyMeter.count()).toBeLessThanOrEqual(5);

    // The per-row FALLBACK (omitted preload), metered on the same rows and
    // viewer: 12 poster selects + 7 metadata selects = 19 — the audit's
    // R×(1..5) arm, alive exactly as before the batching (requirement: the
    // fallback stays intact). The batched route's count above must beat it.
    const pair = await findRepositoryByPath(env.DB, "alice", "visible");
    if (pair === null) throw new Error("repo pair missing");
    const viewer: Viewer = { origin: "https://example.com", requester: null };
    const issueRow = await db()
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id))
      .all()
      .then((rows) => {
        const row = rows[0];
        if (row === undefined) throw new Error("seeded issue row missing");
        return row;
      });
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).orderBy(asc(comments.id)).all();
    const fallbackMeter = countedD1();
    const perRow: TimelineComment[] = [];
    for (const comment of rows) {
      if (comment.type === CommentType.Code) continue; // the route's filter arm
      perRow.push(await toTimelineComment(fallbackMeter.db, viewer, pair, issueRow, comment));
    }
    const fallbackCount = fallbackMeter.count();
    expect(fallbackCount).toBeGreaterThanOrEqual(12); // the per-row posters alone
    expect(count).toBeLessThan(fallbackCount); // 7 vs 19 at this N

    // Contract discipline: the batched route render is deep-equal to the
    // per-row fallback render on the SAME rows and viewer — covers every row
    // kind and the null/dangling arms in one sweep.
    expect(timeline).toEqual(perRow);
    expect(timeline.find((item) => item.type === "close")?.user).toBeNull(); // the null-poster arm
    expect(timeline.filter((item) => item.label !== null)).toHaveLength(1); // the dangling label renders null
    expect(timeline.filter((item) => item.old_milestone !== null)).toHaveLength(1); // the dangling old renders null
    expect(timeline.filter((item) => item.milestone !== null)).toHaveLength(1);
    expect(timeline.filter((item) => item.assignee !== null)).toHaveLength(1); // the dangling assignee renders null
  });
});

// ---------------------------------------------------------------------------
// Issue unit gates (mustEnableIssuesOrPulls, api.go:1674 + api.go:720-746)
// — the parity-review-api E5 gate drift: the issues subtree consults the
// repo_settings has_issues/has_pull_requests flags (the enabled-unit store
// at this pin; services/issue-unit-gates.ts) at upstream's exact chain
// position, after repo resolution and before every handler.
// ---------------------------------------------------------------------------

describe("issue unit gates (mustEnableIssuesOrPulls)", () => {
  it("404s the issues subtree on a unit-less repo while the repo read and the ungated /labels + /milestones twins stay 200", async () => {
    const owner = await seedUser("alice");
    const repoId = await seedRepo(owner.usernameLower, "units");
    const issue = await seedIssue(repoId, "hidden issue");
    await db().insert(repoSettings).values({ repoId, hasIssues: false, hasPullRequests: false });

    const body = { message: "not found", url: ERROR_URL };
    const list = await router()("/repos/alice/units/issues");
    expect(list.status).toBe(404);
    expect(await list.json()).toEqual(body);
    const single = await router()(`/repos/alice/units/issues/${issue.index}`);
    expect(single.status).toBe(404);
    expect(await single.json()).toEqual(body);
    const comments = await router()("/repos/alice/units/issues/comments");
    expect(comments.status).toBe(404);
    expect(await comments.json()).toEqual(body);
    // Creation 404s through the group gate too — and even with the units ON
    // the arm order is upstream's: 404 unit gate first, 423 archived later.
    const created = await router()("/repos/alice/units/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(created.status).toBe(404);
    expect(await created.json()).toEqual(body);

    // The repo-level twins carry NO unit gate upstream (api.go:1675-1688):
    // /labels and /milestones keep serving a unit-less repo, and so does the
    // repo read itself (the code-unit routes stay 200).
    expect((await router()("/repos/alice/units")).status).toBe(200);
    expect((await router()("/repos/alice/units/labels")).status).toBe(200);
    expect((await router()("/repos/alice/units/milestones")).status).toBe(200);
  });

  it("narrows the list `type` to the readable side and hides plain issues when only pulls are readable (issue.go:375-390, :998-1009)", async () => {
    const owner = await seedUser("alice");
    const repoId = await seedRepo(owner.usernameLower, "mixed");
    const plain = await seedIssue(repoId, "plain issue");
    const pull = await service().createPullRequest({
      repoId,
      title: "the pull",
      posterId: owner.id,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "feature",
    });
    await db().insert(repoSettings).values({ repoId, hasIssues: false, hasPullRequests: true });

    // No `type`: upstream forces the filter to the single readable side —
    // the plain issue hides, the pull serves.
    const list = await router()("/repos/alice/mixed/issues");
    expect(list.status).toBe(200);
    const items = await list.json<Array<{ number: number }>>();
    expect(items.map((item) => item.number)).toEqual([pull.issue.index]);

    expect((await router()("/repos/alice/mixed/issues?type=issues")).status).toBe(404);
    expect((await router()("/repos/alice/mixed/issues?type=pulls")).status).toBe(200);

    // The per-issue narrowing of getRepoIssueByIndexForDoer (issue.go:998-1009).
    const hiddenPlain = await router()(`/repos/alice/mixed/issues/${plain.index}`);
    expect(hiddenPlain.status).toBe(404);
    expect(await hiddenPlain.json()).toEqual({ message: "not found", url: ERROR_URL });
    expect((await router()(`/repos/alice/mixed/issues/${pull.issue.index}`)).status).toBe(200);

    // POST /issues carries the route-level `reqRepoReader(unit.TypeIssues)`
    // arm (api.go:1576): the pulls fallback does NOT unlock creation.
    const created = await router()("/repos/alice/mixed/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(created.status).toBe(404);
    expect(await created.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("keeps archived-repo reads serving while creation answers the upstream 423 (mustNotBeArchived, api.go:816-822)", async () => {
    const owner = await seedUser("alice");
    const repoId = await seedRepo(owner.usernameLower, "frozen2", { archived: true });
    await seedIssue(repoId, "frozen issue");

    // The issues group gate is unit-flags only — an archived repo's reads
    // stay 200 (upstream pins: api_issue_test.go PATCHes an archived repo
    // into StatusLocked, so the subtree itself serves).
    const reads = await router()("/repos/alice/frozen2/issues");
    expect(reads.status).toBe(200);
    const items = await reads.json<Array<{ number: number }>>();
    expect(items).toHaveLength(1);

    const created = await router()("/repos/alice/frozen2/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(created.status).toBe(423);
    expect(await created.json()).toEqual({ message: "repo is archived", url: ERROR_URL });
  });
});
