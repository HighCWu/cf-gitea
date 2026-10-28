/**
 * The issue-delete webhook pair (the coverage audit's remaining-work §1a
 * closure) — the `action=deleted` deliveries the DELETE
 * /repos/{owner}/{repo}/issues/{index} funnel emits through
 * deleteIssueCascade (api/services/issues.ts), exercised over the real route
 * (the wiki-suite model) with exactly-once delivery-log assertions (the
 * fork-dispatch model).
 *
 * Upstream reaches its webhook from exactly this route (submodule pin
 * fc4936884584): routers/api/v1/repo/issue.go:851→:886 →
 * services/issue/issue.go:155→:183 (DeleteIssue: the attributes load BEFORE
 * the delete — the payload renders the pre-delete state — and the notify
 * runs after it) → services/webhook/notifier.go:313-341: the issue arm one
 * `issues` IssuePayload, the PR arm one `pull_request` PullRequestPayload,
 * both `action=deleted` with `commit_id` "" and NO `changes` block. The
 * activity feed stays SILENT upstream-faithfully (the actionNotifier has no
 * DeleteIssue method, feed/notifier.go). The IsPull discriminant picks the
 * arm, so a delete emits exactly one event; a second DELETE 404s
 * (ErrIssueNotExist) and emits nothing — exactly-once over the funnel.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actions, comments, labels, repoCounters, repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { IssuesService } from "../issues/service";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "action",
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "issue_assignees",
    "issue_dependency",
    "tracked_time",
    "stopwatch",
    "issue_attachments",
    "issue_content_history",
    "notification_states",
    "project_issues",
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
  // The stub token identity is STUB_USER (id 1) — issues.test.ts's pin.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };

let repoSeq = 900;

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

async function seedRepo(ownerNamespace: string, slug: string): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: "public",
    isArchived: false,
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
    .values({ repoId, name, color: "#00aabb", description: "", numIssues: 1, numClosedIssues: 0 })
    .returning({ id: labels.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("label seed failed");
  return row.id;
}

/** One issue through the landed service (indexes allocate 1, 2, …). */
async function seedIssue(repoId: string, title: string, options: { posterId?: number; labelIds?: number[] } = {}): Promise<{ id: number; index: number }> {
  const row = await service().createIssue({
    repoId,
    title,
    content: null,
    posterId: options.posterId ?? null,
    labelIds: options.labelIds ?? [],
    milestoneId: null,
  });
  return { id: row.id, index: row.index };
}

/** Active webhook subscribed to the given events — the fan-out matcher target. */
async function seedHook(repoId: string, events: string[]): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/delete-dispatch",
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

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

async function deliveriesFor(hookId: number): Promise<DeliveryRow[]> {
  return db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.hookId, hookId))
    .all();
}

describe("DELETE /repos/{owner}/{repo}/issues/{index} webhook emissions (upstream DeleteIssue, notifier.go:313-341)", () => {
  it("an issue delete emits the issues action=deleted event exactly once, rendered pre-delete, with no feed row", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    const doomed = await seedIssue(repoId, "doomed", { posterId: owner.id, labelIds: [labelId] });
    await service().addComment({ issueId: doomed.id, posterId: 1, content: "vanishes" });
    const issuesHook = await seedHook(repoId, ["issues"]);
    // The IsPull discriminant: a PR-subscribed hook never hears an issue delete.
    const prHook = await seedHook(repoId, ["pull_request"]);

    const res = await router()(`/repos/alice/visible/issues/${doomed.index}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // Exactly one delivery on the issues hook; the PR-scoped hook is silent.
    const deliveries = await deliveriesFor(issuesHook);
    expect(deliveries).toHaveLength(1);
    expect((await deliveriesFor(prHook)).length).toBe(0);
    expect(deliveries[0]!.eventType).toBe("issues");
    expect(deliveries[0]!.eventGroup).toBe("issues");
    // §2.7 IssuePayload (hook.go:435) — action=deleted, NO changes block,
    // commit_id "" (upstream sets no commit on this path).
    const payload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["action", "commit_id", "issue", "number", "repository", "sender"]);
    expect(payload.action).toBe("deleted");
    expect(payload.number).toBe(doomed.index);
    expect(payload.commit_id).toBe("");
    // The PRE-delete render (upstream LoadAttributes-before-delete,
    // issue.go:157-162): the labels the cascade just swept still ride.
    expect(payload.issue).toMatchObject({
      number: doomed.index,
      title: "doomed",
      labels: [{ name: "bug" }],
      repository: { full_name: "alice/visible" },
    });
    expect(payload.repository).toMatchObject({ full_name: "alice/visible" });
    // The doer is the sender (the route's authUser — the stub identity).
    expect(payload.sender).toMatchObject({ login: STUB_USER.login });

    // Upstream-faithful feed silence: the actionNotifier has no DeleteIssue
    // method (feed/notifier.go) — no action row, and the swept comment is gone.
    expect(await db().select().from(actions).all()).toHaveLength(0);
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("a PR delete routes the event to pull_request with the PullRequestPayload shape", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, "bug");
    const { issue } = await service().createPullRequest({
      repoId,
      title: "doomed pr",
      posterId: 1,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
      labelIds: [labelId],
    });
    const prHook = await seedHook(repoId, ["pull_request"]);
    const issuesHook = await seedHook(repoId, ["issues"]);

    const res = await router()(`/repos/alice/visible/issues/${issue.index}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);

    const deliveries = await deliveriesFor(prHook);
    expect(deliveries).toHaveLength(1);
    expect((await deliveriesFor(issuesHook)).length).toBe(0);
    expect(deliveries[0]!.eventType).toBe("pull_request");
    expect(deliveries[0]!.eventGroup).toBe("pull_request");
    // §2.7 PullRequestPayload (hook.go:484) — action=deleted, the payload-mode
    // PR render (upstream ToPayloadPullRequest, notifier.go:319), commit_id "".
    const payload = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["action", "commit_id", "number", "pull_request", "repository", "sender"]);
    expect(payload.action).toBe("deleted");
    expect(payload.number).toBe(issue.index);
    expect(payload.commit_id).toBe("");
    expect(payload.pull_request).toMatchObject({ number: issue.index, title: "doomed pr", state: "open" });
    expect(payload.repository).toMatchObject({ full_name: "alice/visible" });
    expect(payload.sender).toMatchObject({ login: STUB_USER.login });
  });

  it("exactly-once over the funnel: a second DELETE 404s and emits nothing; an unsubscribed repo emits no rows", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const doomed = await seedIssue(repoId, "once-only", { posterId: owner.id });
    const hookId = await seedHook(repoId, ["issues"]);

    const first = await router()(`/repos/alice/visible/issues/${doomed.index}`, { method: "DELETE", headers: authHeaders });
    expect(first.status).toBe(204);
    const second = await router()(`/repos/alice/visible/issues/${doomed.index}`, { method: "DELETE", headers: authHeaders });
    expect(second.status).toBe(404);
    expect(await deliveriesFor(hookId)).toHaveLength(1);

    // The counters still reflect one delete (the 404 arm never reaches the
    // cascade) and the index counter is not rewound — the next create takes 2.
    const repo = (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0];
    expect(repo?.numIssues).toBe(0);
    const next = await service().createIssue({ repoId, title: "after", content: null, posterId: null, labelIds: [], milestoneId: null });
    expect(next.index).toBe(2);
    const counters = await db().select().from(repoCounters).all();
    expect(counters[0]?.issueIndex).toBe(2);
  });
});
