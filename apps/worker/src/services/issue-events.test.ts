/**
 * The shared issue-family webhook seam (services/issue-events.ts): BOTH write
 * paths emit IDENTICALLY.
 *
 *   - API path: POST /repos/{owner}/{repo}/issues through the tier-1 router
 *     (src/api/issues.test.ts's emitted-event assertions stay the source of
 *     truth for that surface and pass unchanged; this file re-drives one
 *     create for the side-by-side parity comparison).
 *   - UI path: POST /{owner}/{repo}/issues/new through the uiRouter — the
 *     pages-wave4 harness pattern (router.fetch with the session cookie, no
 *     executionCtx → the Queue enqueue is skipped and rows stay `pending`,
 *     exactly like the API tests' app.request posture) — the write that
 *     emitted NOTHING before the seam landed (the wave-4 divergence).
 *
 * Deliveries are asserted over the webhook_deliveries D1 rows — the delivery
 * log IS the source of truth (SPEC-0005 §3.6).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { contractModelProperties } from "../compat/contract/frozen-contract";
import { ActionType } from "../api/services/activity-feeds";
import { createApiRouter } from "../api/router";
import { actions, repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { emitIssueEvent, type IssueEventExecution } from "./issue-events";
import { uiRouter } from "../ui/index";
import { uiEnv } from "../ui/__tests__/harness";
import { mintSession, SESSION_COOKIE_NAME } from "../ui/session";

const ISSUE_FIELDS = Object.keys(contractModelProperties("Issue")).sort();

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
  // The stub token identity is STUB_USER (id 1) — issues.test.ts's pin.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
});

const db = () => drizzle(env.DB);

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };

const apiRouter = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

/** The pages-wave4 form POST (the §2.8 layer-2 guard's same-origin happy path). */
function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: new URLSearchParams(fields).toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const uiPost = async (path: string, init: RequestInit): Promise<Response> =>
  uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      visibility: "public",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(owner: { id: number; usernameLower: string }, slug: string): Promise<string> {
  const id = `r_issueevt_${slug}`;
  await db().insert(repositories).values({
    id,
    storageKey: id,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug,
    visibility: "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return id;
}

/** Active webhook subscribed to the given events — the fan-out matcher target. */
async function seedHook(repoId: string, events: string[]): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/issue-events-test",
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

async function deliveriesFor(hookId: number): Promise<(typeof webhookDeliveries.$inferSelect)[]> {
  return db().select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).orderBy(asc(webhookDeliveries.id)).all();
}

describe("issue-family webhook emission — both write paths through the shared seam", () => {
  it("the UI new-issue POST emits the same issues opened event the API route emits", async () => {
    const alice = await seedUser("Alice");
    const repoId = await seedRepo(alice, "parity");
    const hookId = await seedHook(repoId, ["issues"]);
    const pushOnlyHookId = await seedHook(repoId, ["push"]); // not subscribed — silent on BOTH paths

    // The API path: token identity, tier-1 route (index 1).
    const apiRes = await apiRouter()("/repos/Alice/parity/issues", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "filed through the API" }),
    });
    expect(apiRes.status).toBe(201);

    // The UI path: session identity, the new-issue form write (index 2) —
    // the path that emitted nothing before the seam.
    const uiRes = await uiPost(
      "/alice/parity/issues/new",
      withCookie(formPost({ title: "filed through the web form" }), await mintSession(env.DB, alice.id)),
    );
    expect(uiRes.status).toBe(303);
    expect(uiRes.headers.get("location")).toBe("/alice/parity/issues/2");

    // Only the issues-subscribed hook heard either path.
    expect(await deliveriesFor(pushOnlyHookId)).toHaveLength(0);
    const deliveries = await deliveriesFor(hookId);
    expect(deliveries).toHaveLength(2);

    const [apiDelivery, uiDelivery] = deliveries;
    expect(apiDelivery!.eventType).toBe("issues");
    expect(uiDelivery!.eventType).toBe("issues");
    expect(apiDelivery!.eventGroup).toBe("issues");
    expect(uiDelivery!.eventGroup).toBe("issues");
    expect(apiDelivery!.state).toBe("pending");
    expect(uiDelivery!.state).toBe("pending");
    expect(apiDelivery!.repoId).toBe(repoId);
    expect(uiDelivery!.repoId).toBe(repoId);

    const apiPayload = JSON.parse(apiDelivery!.payloadContent) as Record<string, unknown>;
    const uiPayload = JSON.parse(uiDelivery!.payloadContent) as Record<string, unknown>;

    // The §2.7 IssuePayload field set is IDENTICAL (the same issueEventPayload
    // builder ran on both paths), with the same action and serialization style.
    expect(Object.keys(apiPayload).sort()).toEqual(["action", "commit_id", "issue", "number", "repository", "sender"]);
    expect(Object.keys(uiPayload).sort()).toEqual(Object.keys(apiPayload).sort());
    expect(apiPayload.action).toBe("opened");
    expect(uiPayload.action).toBe("opened");
    expect(apiDelivery!.payloadContent).toContain('\n  "action": "opened"');
    expect(uiDelivery!.payloadContent).toContain('\n  "action": "opened"');

    // The embedded issue is the SAME wire model on both paths (the contract
    // Issue field set — the shared toApiIssue serializer), with each path's
    // own number.
    expect(Object.keys(apiPayload.issue as object).sort()).toEqual(ISSUE_FIELDS);
    expect(Object.keys(uiPayload.issue as object).sort()).toEqual(ISSUE_FIELDS);
    expect(apiPayload.number).toBe(1);
    expect(uiPayload.number).toBe(2);
    expect((apiPayload.issue as { title: string }).title).toBe("filed through the API");
    expect((uiPayload.issue as { title: string }).title).toBe("filed through the web form");

    // The repository object renders identically; the sender is each path's
    // own doer (token identity vs session doer).
    expect((apiPayload.repository as { full_name: string }).full_name).toBe("alice/parity");
    expect((uiPayload.repository as { full_name: string }).full_name).toBe("alice/parity");
    expect((apiPayload.sender as { login: string }).login).toBe("cf-gitea-stub");
    expect((uiPayload.sender as { login: string }).login).toBe("Alice"); // the session doer's display-cased username
  });

  it("a failed UI write emits nothing (validation failures never fan out)", async () => {
    const alice = await seedUser("Alice");
    const repoId = await seedRepo(alice, "invalid");
    const hookId = await seedHook(repoId, ["issues"]);

    const res = await uiPost(
      "/alice/invalid/issues/new",
      withCookie(formPost({ title: "", content: "no title" }), await mintSession(env.DB, alice.id)),
    );
    expect(res.status).toBe(200); // the re-render convention — no write, no event
    expect(await deliveriesFor(hookId)).toHaveLength(0);
  });

  // The wall-clock seam's now-arm (docs/research/render-wallclock-audit.md):
  // the issue-family action drafts carry no createdAt of their own, so the
  // feed rows the profile-activity/user feeds render as TimeSince used to
  // take recordAction's new Date() default — unreachable by fixtures (the
  // golden had to UPDATE the rows post-hoc). One injected clock now pins
  // BOTH the delivery rows and the action rows.
  it("the injected now lands in the delivery rows AND the action rows (drafts carry none of their own)", async () => {
    const alice = await seedUser("Alice");
    const repoId = await seedRepo(alice, "pinned");
    const hookId = await seedHook(repoId, ["issues"]);
    const fixed = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));

    await emitIssueEvent(
      {
        env,
        // hono's getter throws for in-process callers — mimic it exactly.
        get executionCtx(): IssueEventExecution {
          throw new Error("no execution context (in-process caller)");
        },
      },
      {
        repoId,
        ownerId: alice.id,
        eventType: "issues",
        payload: {
          action: "opened",
          number: 1,
          issue: { number: 1, title: "pinned" },
          repository: { private: false },
          sender: { id: alice.id },
        },
      },
      { now: fixed },
    );

    const [delivery] = await deliveriesFor(hookId);
    expect(delivery).toBeDefined();
    expect(delivery!.createdAt?.getTime()).toBe(fixed.getTime());

    const actionRows = await db().select().from(actions).where(eq(actions.repoId, repoId)).all();
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]!.opType).toBe(ActionType.CreateIssue);
    expect(actionRows[0]!.actUserId).toBe(alice.id);
    expect(actionRows[0]!.createdAt.getTime()).toBe(fixed.getTime());
    expect(actionRows[0]!.content).toBe("1|pinned");
  });
});
