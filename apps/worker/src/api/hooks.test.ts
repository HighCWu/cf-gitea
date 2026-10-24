/**
 * Tier-1 webhook routes on real D1 (SPEC-0004 §2.4 rows: repoListHooks /
 * repoCreateHook / repoGetHook / repoEditHook / repoDeleteHook / repoTestHook /
 * repoListHookDeliveries; behavior owned by SPEC-0005 §2.6). Seeds `users` +
 * `repositories` rows through Drizzle, boots the API router with the stub auth
 * resolver, and asserts the upstream ports exactly: the checkCreateHookOption
 * validation order with Go's messages, the ToHook/ToHookDelivery converters,
 * the PATCH unconditional subscription rewrite, and the PrepareTestWebhook
 * gates-bypassed fire that writes the delivery row synchronously (the Queue
 * message goes through ctx.waitUntil and never blocks the response).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { STUB_USER } from "./auth";
import { ZERO_OID } from "./services/hooks";
import { createApiRouter } from "./router";
import contract from "../compat/contract/v1-swagger.generated.json";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["webhook_deliveries", "webhooks", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const HOOK_FIELDS = Object.keys(contract.definitions.Hook.properties).sort();
const DELIVERY_FIELDS = Object.keys(contract.definitions.HookDelivery.properties).sort();
/** Upstream-`omitempty` Repository fields absent for D1-only repos. */
const OMITTED_REPOSITORY_FIELDS = new Set([
  "default_target_branch",
  "external_tracker",
  "external_wiki",
  "parent",
  "repo_transfer",
]);
const REPOSITORY_FIELDS = Object.keys(contract.definitions.Repository.properties)
  .filter((name) => !OMITTED_REPOSITORY_FIELDS.has(name))
  .sort();

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

async function seedRepo(slug: string, refsVersion = 1): Promise<string> {
  const owner = await db()
    .insert(users)
    .values({ username: "Alice", usernameLower: "alice", isAdmin: false, status: "active", createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning()
    .all();
  const user = owner[0];
  if (user === undefined) throw new Error("user seed failed");
  const rows = await db()
    .insert(repositories)
    .values({
      id: `repo-${slug}`,
      storageKey: `r_repo-${slug}`,
      ownerNamespace: "alice",
      ownerId: user.id,
      slug,
      visibility: "public",
      refsVersion,
      backend: "self-hosted",
      createdAt: new Date("2026-02-03T04:05:06Z"),
    })
    .returning({ id: repositories.id })
    .all();
  const repo = rows[0];
  if (repo === undefined) throw new Error("repo seed failed");
  return repo.id;
}

interface SeedHookInput {
  url?: string;
  type?: string;
  active?: boolean;
  events?: string;
  contentType?: number;
}

async function seedHook(repoId: string, input: SeedHookInput = {}): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId,
      name: "seeded",
      url: input.url ?? "https://hooks.example.com/target",
      contentType: input.contentType ?? 1,
      events: input.events ?? JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true } }),
      isActive: input.active ?? false,
      type: input.type ?? "gitea",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: webhooks.id })
    .all();
  const hook = rows[0];
  if (hook === undefined) throw new Error("hook seed failed");
  return hook.id;
}

const createBody = JSON.stringify({
  type: "gitea",
  config: { url: "https://hooks.example.com/ci", content_type: "json", secret: "s3cret" },
});

describe("POST /repos/{owner}/{repo}/hooks (repoCreateHook)", () => {
  it("creates with the exact contract Hook field set and upstream defaults (active FALSE, events [push])", async () => {
    const repoId = await seedRepo("visible");

    const res = await router()("/repos/Alice/visible/hooks", { method: "POST", headers: authHeaders, body: createBody });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(HOOK_FIELDS);
    expect(body).toMatchObject({
      type: "gitea",
      name: "",
      active: false, // CreateHookOption.active defaults to FALSE (SPEC-0004 §2.4)
      branch_filter: "",
      config: { url: "https://hooks.example.com/ci", content_type: "json" },
      events: ["push"], // empty events list defaults to push (updateHookEvents)
      authorization_header: "", // the stored secret never renders
    });
    expect(typeof body.id).toBe("number");

    // Storage: the secret lands in its column, the config free-map is honored.
    const stored = await db().select().from(webhooks).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ repoId, url: "https://hooks.example.com/ci", secret: "s3cret", httpMethod: "POST" });
  });

  it("stores the events subscription, branch filter, and the slack meta block", async () => {
    await seedRepo("visible");

    const slack = await router()("/repos/alice/visible/hooks", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        type: "slack",
        config: { url: "https://hooks.example.com/slack", content_type: "form", channel: "#ci", username: "bot", color: "#ff0000" },
        events: ["push", "release"],
        branch_filter: "main",
        active: true,
        name: "  CI relay  ",
      }),
    });
    expect(slack.status).toBe(201);
    const body = await slack.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      type: "slack",
      name: "CI relay",
      active: true,
      branch_filter: "main",
      events: ["push", "release"],
      config: {
        url: "https://hooks.example.com/slack",
        content_type: "form",
        channel: "#ci",
        username: "bot",
        icon_url: "",
        color: "#ff0000",
      },
    });
  });

  it.each([
    // checkCreateHookOption order (routers/api/v1/utils/hook.go) with Go's
    // exact messages — the declared zod enum cannot express the type case.
    [{ type: "gitea", config: { content_type: "json" } }, 422, "Missing config option: url"],
    [{ type: "gitea", config: { url: "https://x.example.com" } }, 422, "Missing config option: content_type"],
    [{ type: "gitea", config: { url: "https://x.example.com", content_type: "yaml" } }, 422, "Invalid content type"],
    [{ type: "gitea", config: { url: "not a url", content_type: "json" } }, 422, "Invalid url"],
    // addHook tail: the is_system_webhook ParseBool gate.
    [
      { type: "gitea", config: { url: "https://x.example.com", content_type: "json", is_system_webhook: "often" } },
      422,
      "Invalid is_system_webhook value",
    ],
    // Slack channel requirement (missing → 422, blank → 400).
    [{ type: "slack", config: { url: "https://x.example.com", content_type: "json" } }, 422, "Missing config option: channel"],
    [{ type: "slack", config: { url: "https://x.example.com", content_type: "json", channel: "   " } }, 400, "Invalid slack channel name"],
  ])("answers %s with %i %s", async (body, status, message) => {
    await seedRepo("visible");

    const res = await router()("/repos/alice/visible/hooks", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ message, url: ERROR_URL });
    expect(await db().select().from(webhooks).all()).toHaveLength(0);
  });

  it("bind-fails schema-invalid bodies with 422 and malformed JSON with hono's 400 (runtime-only codes)", async () => {
    await seedRepo("visible");

    // Schema violation → the body hook (upstream bind() 422s everything).
    const noType = await router()("/repos/alice/visible/hooks", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ config: { url: "https://x.example.com", content_type: "json" } }),
    });
    expect(noType.status).toBe(422);
    expect(await noType.json()).toEqual({ message: "invalid request body", url: ERROR_URL });

    // Malformed JSON never reaches the schema — hono's media-type gate 400s
    // (the markdown-documented bind divergence), in the Gitea error shape.
    const malformed = await router()("/repos/alice/visible/hooks", {
      method: "POST",
      headers: authHeaders,
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ message: "Malformed JSON in request body", url: ERROR_URL });

    // A provider outside the contract's 10-value enum fails the schema gate
    // → the body hook's 422 (Go's message "Invalid hook type: irc" is
    // unreachable behind the declared enum — same-message-class divergence).
    const badType = await router()("/repos/alice/visible/hooks", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ type: "irc", config: { url: "https://x.example.com", content_type: "json" } }),
    });
    expect(badType.status).toBe(422);
    expect(await badType.json()).toEqual({ message: "invalid request body", url: ERROR_URL });
  });

  it("requires a token (401) and a visible repository (404)", async () => {
    await seedRepo("visible");

    const anon = await router()("/repos/alice/visible/hooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: createBody });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await router()("/repos/alice/ghost/hooks", { method: "POST", headers: authHeaders, body: createBody });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/hooks (repoListHooks)", () => {
  it("lists id ASC with pagination headers and the contract field set", async () => {
    const repoId = await seedRepo("visible");
    await seedHook(repoId, { url: "https://one.example.com" });
    await seedHook(repoId, { url: "https://two.example.com" });
    await seedHook("repo-other", { url: "https://elsewhere.example.com" }); // other repo — never leaks

    const res = await router()("/repos/alice/visible/hooks", { method: "GET", headers: authHeaders });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toBeNull();
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((hook) => (hook.config as Record<string, string>).url)).toEqual([
      "https://one.example.com",
      "https://two.example.com",
    ]);
    for (const hook of body) expect(Object.keys(hook).sort()).toEqual(HOOK_FIELDS);
  });

  it("paginates with limit/page and clamps like upstream", async () => {
    const repoId = await seedRepo("visible");
    await seedHook(repoId, { url: "https://one.example.com" });
    await seedHook(repoId, { url: "https://two.example.com" });

    const res = await router()("/repos/alice/visible/hooks?limit=1&page=2", { headers: authHeaders });
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="prev"');
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(((body[0]?.config ?? {}) as Record<string, string>).url).toBe("https://two.example.com");
  });

  it("404s a missing or invisible repository with the exact body", async () => {
    await seedRepo("visible");
    const res = await router()("/repos/alice/ghost/hooks", { headers: authHeaders });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET/PATCH/DELETE /repos/{owner}/{repo}/hooks/{id}", () => {
  it("gets one hook by repo-scoped id and 404s foreign ids with the contract field set", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId, { url: "https://one.example.com", active: true });
    await seedHook("repo-other", { url: "https://elsewhere.example.com" });

    const res = await router()(`/repos/alice/visible/hooks/${id}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(HOOK_FIELDS);
    expect(body).toMatchObject({ id, name: "seeded", active: true });

    // Non-integer ids parse to 0 like Go's PathParamInt64 (lookup miss → 404).
    for (const bad of ["9999", "abc", "0"]) {
      const miss = await router()(`/repos/alice/visible/hooks/${bad}`, { headers: authHeaders });
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ message: "not found", url: ERROR_URL });
    }
  });

  it("patches a partial update (url, active, name) and keeps unspecified fields", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId, {
      url: "https://old.example.com",
      active: false,
      events: JSON.stringify({ choose_events: true, branch_filter: "dev*", events: { push: true, issues: true } }),
    });

    const res = await router()(`/repos/alice/visible/hooks/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        active: true,
        config: { url: "https://new.example.com" },
        events: ["push", "release"], // resupplied — the rewrite is unconditional
        branch_filter: "dev*",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id, active: true });
    expect((body.config as Record<string, string>).url).toBe("https://new.example.com");
    // content_type was not in the PATCH config → the stored json renders.
    expect((body.config as Record<string, string>).content_type).toBe("json");
    expect(body.events).toEqual(["push", "release"]);
    expect(body.branch_filter).toBe("dev*");
  });

  it("applies the upstream PATCH quirks: events and branch_filter are unconditional (empty PATCH resets to push-only and clears the filter)", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId, {
      events: JSON.stringify({
        choose_events: true,
        branch_filter: "release/*",
        events: { push: true, issues: true, release: true },
      }),
    });

    const res = await router()(`/repos/alice/visible/hooks/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ name: "renamed" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("renamed");
    expect(body.events).toEqual(["push"]); // subscription reset to push-only
    expect(body.branch_filter).toBe(""); // filter cleared
  });

  it("validates a supplied url/content_type on PATCH with upstream's messages", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId);

    for (const [config, message] of [
      [{ url: "nope" }, "Invalid url"],
      [{ content_type: "yaml" }, "Invalid content type"],
    ] as const) {
      const res = await router()(`/repos/alice/visible/hooks/${id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ config }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ message, url: ERROR_URL });
    }
  });

  it("deletes with 204 and then 404s the same id (and anything in another repo)", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId);

    const del = await router()(`/repos/alice/visible/hooks/${id}`, { method: "DELETE", headers: authHeaders });
    expect(del.status).toBe(204);
    expect(await db().select().from(webhooks).all()).toHaveLength(0);

    const again = await router()(`/repos/alice/visible/hooks/${id}`, { method: "DELETE", headers: authHeaders });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("POST /repos/{owner}/{repo}/hooks/{id}/tests (repoTestHook)", () => {
  it("fires a push delivery synchronously: 204, pending row, upstream payload shape and 2-space bytes", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId, { active: false }); // inactive hooks fire too (gates bypassed)

    const res = await router()(`/repos/alice/visible/hooks/${id}/tests`, { method: "POST", headers: authHeaders });

    expect(res.status).toBe(204);
    const rows = await db().select().from(webhookDeliveries).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("delivery row missing");
    expect(row).toMatchObject({
      hookId: id,
      repoId,
      eventType: "push",
      eventGroup: "push",
      state: "pending",
      isSucceed: false,
    });
    expect(row.uuid).toBeTruthy();

    // The compat-frozen payload (SPEC-0005 §2.7): the exact field set, the
    // default ref, zero-OID commit ids, and the 2-space pretty format.
    const payload = JSON.parse(row.payloadContent) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["after", "before", "commits", "compare_url", "head_commit", "pusher", "ref", "repository", "sender", "total_commits"].sort(),
    );
    expect(payload).toMatchObject({
      ref: "refs/heads/main",
      before: ZERO_OID,
      after: ZERO_OID,
      compare_url: `alice/visible/compare/${ZERO_OID}...${ZERO_OID}`,
      commits: [],
      total_commits: 0,
      head_commit: null,
    });
    expect(Object.keys(payload.repository as Record<string, unknown>).sort()).toEqual(REPOSITORY_FIELDS);
    expect(payload.pusher).toMatchObject({ id: STUB_USER.id, login: STUB_USER.login });
    expect(payload.sender).toMatchObject({ id: STUB_USER.id, login: STUB_USER.login });
    expect(row.payloadContent).toBe(JSON.stringify(payload, null, 2)); // exactly 2-space bytes
  });

  it("uses the trimmed ?ref= query verbatim in the payload", async () => {
    const repoId = await seedRepo("visible");
    const id = await seedHook(repoId);

    const res = await router()(`/repos/alice/visible/hooks/${id}/tests?ref=refs/tags/v1.0`, { method: "POST", headers: authHeaders });

    expect(res.status).toBe(204);
    const rows = await db().select().from(webhookDeliveries).all();
    const payload = JSON.parse(rows[0]?.payloadContent ?? "{}") as { ref?: string };
    expect(payload.ref).toBe("refs/tags/v1.0");
  });

  it("204s an empty repository WITHOUT firing (upstream ctx.Repo.Commit == nil early return, hook unchecked)", async () => {
    const repoId = await seedRepo("empty", 0); // refsVersion 0 ⇔ no commits
    await seedHook(repoId);

    const res = await router()("/repos/alice/empty/hooks/999999/tests", { method: "POST", headers: authHeaders });

    expect(res.status).toBe(204);
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(0);
  });

  it("404s an unknown hook id (repo-scoped)", async () => {
    const repoId = await seedRepo("visible");
    await seedHook(repoId);

    const res = await router()("/repos/alice/visible/hooks/424242/tests", { method: "POST", headers: authHeaders });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
    expect(await db().select().from(webhookDeliveries).all()).toHaveLength(0);
  });

  it("requires a token (401) and a visible repository (404)", async () => {
    await seedRepo("visible");

    const anon = await router()("/repos/alice/visible/hooks/1/tests", { method: "POST" });
    expect(anon.status).toBe(401);

    const missing = await router()("/repos/alice/ghost/hooks/1/tests", { method: "POST", headers: authHeaders });
    expect(missing.status).toBe(404);
  });
});

describe("GET /repos/{owner}/{repo}/hooks/{id}/deliveries (repoListHookDeliveries)", () => {
  interface SeedDeliveryInput {
    state: "pending" | "delivered";
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    createdAt?: Date;
    deliveredAt?: Date | null;
  }

  async function seedDelivery(hookId: number, input: SeedDeliveryInput): Promise<number> {
    const rows = await db()
      .insert(webhookDeliveries)
      .values({
        hookId,
        repoId: "repo-visible",
        uuid: crypto.randomUUID(),
        eventType: "push",
        eventGroup: "push",
        payloadContent: JSON.stringify({ ref: "refs/heads/main" }),
        state: input.state,
        isSucceed: input.state === "delivered",
        requestContent: input.request === undefined ? null : JSON.stringify(input.request),
        responseContent: input.response === undefined ? null : JSON.stringify(input.response),
        createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00Z"),
        deliveredAt: input.deliveredAt === undefined ? null : input.deliveredAt,
      })
      .returning({ id: webhookDeliveries.id })
      .all();
    const row = rows[0];
    if (row === undefined) throw new Error("delivery seed failed");
    return row.id;
  }

  it("lists newest-first with the delivery field set and NO payload bodies (upstream ListDeliveries)", async () => {
    const repoId = await seedRepo("visible");
    const hookId = await seedHook(repoId);
    await seedDelivery(hookId, {
      state: "pending",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedDelivery(hookId, {
      state: "delivered",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      deliveredAt: new Date("2026-01-02T00:01:00Z"),
      request: { url: "https://hooks.example.com/target", http_method: "POST", headers: { Authorization: "******" }, body: "{}" },
      response: { status: 200, headers: {}, body: "ok" },
    });
    await seedDelivery(hookId, { state: "pending", createdAt: new Date("2026-01-03T00:00:00Z") });

    const res = await router()(`/repos/alice/visible/hooks/${hookId}/deliveries`, { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const body = await res.json<Array<Record<string, unknown>>>();
    // hook_task.id DESC (ToOrders default).
    expect(body.map((d) => d.is_delivered)).toEqual([false, true, false]);
    // Pending rows: the contract set minus request/response (the model leaves
    // them optional; Go renders the nil pointers as JSON null keys, ours
    // omits — the delivered row carries all seven).
    const pendingKeys = DELIVERY_FIELDS.filter((f) => f !== "request" && f !== "response");
    expect(Object.keys(body[0] ?? {}).sort()).toEqual(pendingKeys);
    expect(Object.keys(body[1] ?? {}).sort()).toEqual(DELIVERY_FIELDS);
    expect(Object.keys(body[2] ?? {}).sort()).toEqual(pendingKeys);
    const delivered = body[1] as { request: Record<string, unknown>; response: Record<string, unknown> };
    expect(delivered).toMatchObject({ is_delivered: true, is_succeeded: true, delivered_at: "2026-01-02T00:01:00.000Z" });
    // Payload fields omitted from list rows — only the envelope survives.
    expect(delivered.request).toMatchObject({ url: "https://hooks.example.com/target", http_method: "POST" });
    expect(delivered.request).not.toHaveProperty("body");
    expect(delivered.request).not.toHaveProperty("headers");
    expect(delivered.response).toMatchObject({ status: 200 });
    expect(delivered.response).not.toHaveProperty("body");
    // Undelivered rows render upstream's nil-pointer null.
    expect(body[0]?.delivered_at).toBeNull();
  });

  it("paginates and 404s an unknown hook before listing anything", async () => {
    const repoId = await seedRepo("visible");
    const hookId = await seedHook(repoId);
    await seedDelivery(hookId, { state: "pending" });
    await seedDelivery(hookId, { state: "pending" });

    const page = await router()(`/repos/alice/visible/hooks/${hookId}/deliveries?limit=1&page=1`, { headers: authHeaders });
    expect(page.headers.get("X-Total-Count")).toBe("2");
    expect(page.headers.get("Link")).toContain('rel="next"');
    expect(await page.json<unknown[]>()).toHaveLength(1);

    const miss = await router()("/repos/alice/visible/hooks/8888/deliveries", { headers: authHeaders });
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});
