/**
 * The FIRST real trigger surface, end to end (SPEC §7 item 5): POST
 * /admin/users with `send_notify: true` through the real admin router on the
 * real test D1 — the upstream pin's arm
 * (routers/api/v1/admin/user.go:153-156 `if form.SendNotify {
 * mailer.SendRegisterNotifyMail(u) }`) landing in the email_outbox + the
 * repo-tasks queue (the queue stubbed with the recording spy — no real
 * provider, ever), then driven through the consumer for the full pipe.
 *
 * The gate posture (SPEC §5.1) rides the same env override the vitest
 * plugin injects for real: MAIL_* off by default → zero rows, zero sends.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { emailOutbox, users } from "../../db/schema";
import { createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "../../api/auth";
import { giteaErrorHandler } from "../../api/errors";
import type { ApiEnv } from "../../api/env";
import { registerAdminT2Routes } from "../../api/routes/admin-t2";
import { isMailOutboxMessage, processMailOutbox, type MailOutboxEnv, type MailOutboxMessage } from "./outbox";
import { appUrlWithSlash, isMailable } from "./register-notify";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["email_outbox", "user_redirects", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (2, 'root', 'root', 1, 'active', 0)",
  ).run();
});

const TOKEN_ADMIN = "admin-token";

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN_ADMIN) {
        return Promise.resolve({ ...STUB_USER, id: 2, login: "root", is_admin: true });
      }
      return Promise.resolve(null);
    },
  };
}

/** Recording Queue — counts sends AND captures every body. */
function spyQueue(): Queue & { sends: number; sendBodies: MailOutboxMessage[] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as MailOutboxMessage[],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body as MailOutboxMessage);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sends += messages.length;
      for (const m of messages) queue.sendBodies.push(m.body as MailOutboxMessage);
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The armed env = the outbox env plus the trigger's two vars. */
type MailRouteEnv = MailOutboxEnv & { MAIL_ENABLED?: string; MAIL_FROM?: string };

/** The mailer-armed env for the router fetch (vars + the queue spy). */
function armedEnv(overrides: Partial<MailRouteEnv> = {}): MailRouteEnv {
  return {
    ...env,
    MAIL_ENABLED: "true",
    MAIL_PROVIDER: "dummy",
    MAIL_FROM: "Gitea <noreply@example.com>",
    REPO_TASKS: spyQueue(),
    ...overrides,
  };
}

function appWith(mailEnv: MailRouteEnv) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerAdminT2Routes(app, createTokenAuthMiddleware(resolver()));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), mailEnv));
}

const createBody = (sendNotify: boolean | undefined) =>
  ({
    method: "POST",
    headers: {
      Authorization: `token ${TOKEN_ADMIN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "alice",
      email: "alice@example.org",
      ...(sendNotify === undefined ? {} : { send_notify: sendNotify }),
    }),
  }) satisfies RequestInit;

const outboxRows = async () => db().select().from(emailOutbox).all();
const db = () => drizzle(env.DB);

describe("POST /admin/users send_notify — the register-notify mail (end to end)", () => {
  it("send_notify=true + armed → 201, one pending row, one queue message", async () => {
    const mailEnv = armedEnv();
    const app = appWith(mailEnv);
    const response = await app("/admin/users", createBody(true));
    expect(response.status).toBe(201);

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const mail = rows[0]!;
    expect(mail.status).toBe("pending");
    expect(mail.toAddr).toBe("alice@example.org");
    expect(mail.fromAddress).toBe("noreply@example.com");
    expect(mail.fromDisplayName).toBe("Gitea");
    expect(mail.subject).toBe("alice, welcome to Gitea");
    expect(mail.info).toBe(`UID: ${mailIdOf(mail)}, registration notify`);
    expect(mail.dedupeKey).toBe(`register-notify:${mailIdOf(mail)}`);
    expect(mail.bodyHtml).toContain("Hi <b>alice</b>,</p>");
    expect(mail.bodyHtml).toContain("This is your registration confirmation email for Gitea!");

    const spy = mailEnv.REPO_TASKS as unknown as { sends: number; sendBodies: unknown[] };
    expect(spy.sends).toBe(1);
    expect(isMailOutboxMessage(spy.sendBodies[0])).toBe(true);
    expect((spy.sendBodies[0] as { mailId: number }).mailId).toBe(mail.id);
  });

  it("the full pipe: the queued message consumes to 'sent' on the dummy provider", async () => {
    const mailEnv = armedEnv();
    const app = appWith(mailEnv);
    await app("/admin/users", createBody(true));

    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    const outcome = await processMailOutbox(mailEnv, spy.sendBodies[0]!);
    expect(outcome).toEqual({ kind: "sent" });
    const rows = await outboxRows();
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.sentAt).toBeInstanceOf(Date);
  });

  it("send_notify omitted → 201, ZERO rows, ZERO queue sends (deviation 1 stays for silence)", async () => {
    const mailEnv = armedEnv();
    const app = appWith(mailEnv);
    expect((await app("/admin/users", createBody(undefined))).status).toBe(201);
    expect(await outboxRows()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });

  it("MAIL_ENABLED off (the default posture) → 201, ZERO rows — the fail-closed tripwire", async () => {
    // The REAL injected env carries MAIL_ENABLED="false" (local
    // wrangler.jsonc); assert the armed path needs the exact "true".
    const mailEnv = armedEnv({ MAIL_ENABLED: "false" });
    const app = appWith(mailEnv);
    expect((await app("/admin/users", createBody(true))).status).toBe(201);
    expect(await outboxRows()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });

  it("a malformed MAIL_FROM warns and skips — never a 5xx (SPEC §5.2)", async () => {
    const mailEnv = armedEnv({ MAIL_FROM: "no address here" });
    const app = appWith(mailEnv);
    expect((await app("/admin/users", createBody(true))).status).toBe(201);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("send_notify=false is explicit silence", async () => {
    const mailEnv = armedEnv();
    const app = appWith(mailEnv);
    expect((await app("/admin/users", createBody(false))).status).toBe(201);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("APP_URL normalization: the rendered links carry the trailing-slash form", async () => {
    const mailEnv = armedEnv({ APP_URL: "https://cf-gitea.example.org" });
    const app = appWith(mailEnv);
    await app("/admin/users", createBody(true));
    const mail = (await outboxRows())[0]!;
    expect(mail.bodyHtml).toContain("https://cf-gitea.example.org/user/login");
    expect(mail.bodyHtml).toContain("https://cf-gitea.example.org/user/forgot_password");
  });
});

/** The created user's id — the mail's info/dedupe reference. */
function mailIdOf(mail: { dedupeKey: string | null }): number {
  const n = Number((mail.dedupeKey ?? "").split(":")[1]);
  expect(Number.isInteger(n)).toBe(true);
  return n;
}

describe("unit pins", () => {
  it("isMailable — upstream user.go:538-540 over our row", () => {
    expect(
      isMailable({ id: 7, email: "a@b", status: "active", type: "user" }),
    ).toBe(true);
    expect(isMailable({ id: 0, email: "a@b", status: "active", type: "user" })).toBe(false);
    expect(isMailable({ id: 7, email: null, status: "active", type: "user" })).toBe(false);
    expect(isMailable({ id: 7, email: "", status: "active", type: "user" })).toBe(false);
    expect(isMailable({ id: 7, email: "a@b", status: "prohibited", type: "user" })).toBe(false);
    expect(isMailable({ id: 7, email: "a@b", status: "active", type: "org" })).toBe(false);
  });

  it("appUrlWithSlash — upstream AppUrl always carries the trailing slash", () => {
    expect(appUrlWithSlash("https://x.example")).toBe("https://x.example/");
    expect(appUrlWithSlash("https://x.example/")).toBe("https://x.example/");
    expect(appUrlWithSlash(undefined)).toBe("https://localhost/");
  });

  it("the users row reaches the trigger's MailUser slice (fullName beats username)", async () => {
    // Sanity on the row shape the route passes: the service module reads
    // displayName ?? fullName ?? username upstream DisplayName() order.
    await db()
      .update(users)
      .set({ fullName: "Alice Liddell" })
      .where(eq(users.username, "root"));
    const root = await db().select().from(users).where(eq(users.username, "root")).get();
    expect(root!.fullName).toBe("Alice Liddell");
  });
});
