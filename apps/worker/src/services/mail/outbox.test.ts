/**
 * The mail outbox (services/mail/outbox.ts) + the transport contract
 * (services/mail/transport.ts) on the real test D1 — the SPEC §7 items 3-4:
 * the provider contract against a fake fetch (no network, ever), the
 * queue-consumer retry/idempotency discipline (CAS claim, permanent-vs-
 * transient taxonomy, the attempt budget), and the recording queue spy
 * (demo-sweep.test.ts's shape).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailOutbox } from "../../db/schema";
import {
  enqueueMailOutbox,
  isMailOutboxMessage,
  MAIL_MAX_ATTEMPTS,
  processMailOutbox,
  runMailOutboxArm,
  type MailOutboxEnv,
} from "./outbox";
import {
  DummyTransport,
  MailPermanentError,
  MailTransientError,
  resolveTransport,
  ResendTransport,
} from "./transport";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM email_outbox").run();
});

const db = () => drizzle(env.DB);

/** Recording Queue — counts send/sendBatch AND captures every body. */
function spyQueue(): Queue & {
  sends: number;
  sendBodies: unknown[];
} {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as unknown[],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sends += messages.length;
      for (const m of messages) queue.sendBodies.push(m.body);
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

const DRAFT = {
  info: "UID: 7, registration notify",
  fromAddress: "noreply@example.com",
  fromDisplayName: "Gitea",
  toAddr: "alice@example.org",
  replyTo: null,
  subject: "Alice, welcome to Gitea",
  bodyHtml: "<p>Hi <b>Alice</b>,</p>",
  headers: null,
  dedupeKey: "register-notify:7",
};

/** A full MailOutboxEnv over the test bindings, mailer armed on the dummy. */
function mailEnv(overrides: Partial<MailOutboxEnv> = {}): MailOutboxEnv {
  return {
    DB: env.DB,
    REPO_TASKS: spyQueue(),
    APP_URL: "https://cf-gitea.example.org",
    MAIL_PROVIDER: "dummy",
    ...overrides,
  };
}

const row = async (mailId: number) =>
  (await db().select().from(emailOutbox).where(eq(emailOutbox.id, mailId)).get())!;

describe("enqueueMailOutbox (the producer)", () => {
  it("inserts a pending row and hands {kind: mail-outbox, mailId} to the queue", async () => {
    const mailEnvSpy = mailEnv();
    const result = await enqueueMailOutbox(mailEnvSpy, DRAFT, { now: new Date(0) });
    expect(result.outcome).toBe("queued");

    const stored = await row(result.mailId);
    expect(stored.status).toBe("pending");
    expect(stored.attempts).toBe(0);
    expect(stored.toAddr).toBe("alice@example.org");
    expect(stored.dedupeKey).toBe("register-notify:7");
    expect(stored.createdAt).toEqual(new Date(0));

    const spy = mailEnvSpy.REPO_TASKS as unknown as { sends: number; sendBodies: unknown[] };
    expect(spy.sends).toBe(1);
    expect(spy.sendBodies[0]).toEqual({ kind: "mail-outbox", mailId: result.mailId });
  });

  it("dedupes on the arbiter: second insert → the winner's row, no second message", async () => {
    const spy = mailEnv();
    const first = await enqueueMailOutbox(spy, DRAFT);
    const second = await enqueueMailOutbox(spy, DRAFT);
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("deduped");
    expect(second.mailId).toBe(first.mailId);
    expect((await db().select().from(emailOutbox).all()).length).toBe(1);
    expect((spy.REPO_TASKS as unknown as { sends: number }).sends).toBe(1);
  });

  it("a null dedupe key never collides (un-deduped triggers coexist)", async () => {
    const spy = mailEnv();
    const a = await enqueueMailOutbox(spy, { ...DRAFT, dedupeKey: null });
    const b = await enqueueMailOutbox(spy, { ...DRAFT, dedupeKey: null });
    expect(a.outcome).toBe("queued");
    expect(b.outcome).toBe("queued");
    expect(b.mailId).not.toBe(a.mailId);
  });

  it("a queue-send failure leaves the row pending (SPEC §4.5)", async () => {
    const brokenQueue = {
      send: () => Promise.reject(new Error("queue unavailable")),
    } as unknown as Queue;
    const result = await enqueueMailOutbox(
      { DB: env.DB, REPO_TASKS: brokenQueue },
      { ...DRAFT, dedupeKey: null },
    );
    expect(result.outcome).toBe("pending-unqueued");
    expect((await row(result.mailId)).status).toBe("pending");
  });
});

describe("resolveTransport + the transport contract (SPEC §7 item 3)", () => {
  it("selects dummy by default AND for unknown providers (never a silent real sender)", () => {
    expect(resolveTransport({})).toBeInstanceOf(DummyTransport);
    expect(resolveTransport({ MAIL_PROVIDER: "" })).toBeInstanceOf(DummyTransport);
    expect(resolveTransport({ MAIL_PROVIDER: "carrier-pigeon" })).toBeInstanceOf(DummyTransport);
  });

  it("resend without its key is a PERMANENT error naming the config", () => {
    expect(() => resolveTransport({ MAIL_PROVIDER: "resend" })).toThrow(MailPermanentError);
    expect(() => resolveTransport({ MAIL_PROVIDER: "resend" })).toThrow(/MAIL_PROVIDER_API_KEY/);
  });

  it("dummy records and resolves", async () => {
    const dummy = new DummyTransport();
    await dummy.send({
      from: "Gitea <noreply@x>",
      to: "a@b",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
      replyTo: null,
      headers: {},
    });
    expect(dummy.sent).toHaveLength(1);
    expect(dummy.sent[0]!.to).toBe("a@b");
  });

  it("resend maps the message to the provider's JSON POST (fake fetch)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      calls.push({ url: url as string, init: init ?? {} });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const transport = new ResendTransport("re_key_123", fetchImpl, "https://relay.example/api");
    await transport.send({
      from: "Gitea <noreply@x>",
      to: "alice@example.org",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      replyTo: "no-reply@x",
      headers: { "X-Gitea-Sender": "root" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/api/emails");
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer re_key_123");
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      from: "Gitea <noreply@x>",
      to: ["alice@example.org"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      reply_to: "no-reply@x",
      headers: { "X-Gitea-Sender": "root" },
    });
  });

  it("omits reply_to/headers when absent", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      body = JSON.parse((init?.body ?? "{}") as string) as Record<string, unknown>;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    await new ResendTransport("k", fetchImpl).send({
      from: "a@x",
      to: "b@y",
      subject: "s",
      html: "h",
      text: "t",
      replyTo: null,
      headers: {},
    });
    expect("reply_to" in body).toBe(false);
    expect("headers" in body).toBe(false);
  });

  it("4xx = permanent, 429/5xx/network = transient", async () => {
    const transport = (status: number, body = "") =>
      new ResendTransport("k", () => Promise.resolve(new Response(body, { status })));
    await expect(transport(400).send(bareMail())).rejects.toBeInstanceOf(MailPermanentError);
    await expect(transport(422, "domain not verified").send(bareMail())).rejects.toBeInstanceOf(
      MailPermanentError,
    );
    await expect(transport(429).send(bareMail())).rejects.toBeInstanceOf(MailTransientError);
    await expect(transport(502).send(bareMail())).rejects.toBeInstanceOf(MailTransientError);
    const netFail = new ResendTransport("k", () => Promise.reject(new Error("socket down")));
    await expect(netFail.send(bareMail())).rejects.toBeInstanceOf(MailTransientError);
    await expect(netFail.send(bareMail())).rejects.toThrow(/socket down/);
  });
});

function bareMail() {
  return {
    from: "a@x",
    to: "b@y",
    subject: "s",
    html: "h",
    text: "t",
    replyTo: null,
    headers: {},
  };
}

describe("processMailOutbox (the consumer, SPEC §7 item 4)", () => {
  it("dummy: claim → send → sent + sent_at; redelivery is a noop", async () => {
    const e = mailEnv();
    const { mailId } = await enqueueMailOutbox(e, DRAFT);
    const first = await processMailOutbox(e, { kind: "mail-outbox", mailId });
    expect(first).toEqual({ kind: "sent" });
    const stored = await row(mailId);
    expect(stored.status).toBe("sent");
    expect(stored.attempts).toBe(1);
    expect(stored.sentAt).toBeInstanceOf(Date);
    // The claim is status-gated: a redelivery (queue at-least-once) no-ops.
    expect(await processMailOutbox(e, { kind: "mail-outbox", mailId })).toEqual({ kind: "noop" });
    expect((await row(mailId)).attempts).toBe(1);
  });

  it("the consumer shapes at send time (prefix + Message-ID computed per attempt)", async () => {
    const e = mailEnv({ MAIL_SUBJECT_PREFIX: "[cf-gitea]" });
    const { mailId } = await enqueueMailOutbox(e, DRAFT);
    expect(await processMailOutbox(e, { kind: "mail-outbox", mailId })).toEqual({ kind: "sent" });
    expect((await row(mailId)).status).toBe("sent");
    // The stored row stays UNSANITIZED/unshaped (SPEC §4.2); the send-time
    // transform is reproducible from it — the wire view the transport saw:
    const { shapeOutgoingMail } = await import("./message");
    const shaped = shapeOutgoingMail(await row(mailId), {
      subjectPrefix: "[cf-gitea]",
      appUrl: e.APP_URL,
    });
    expect(shaped.subject).toBe("[cf-gitea] Alice, welcome to Gitea");
    expect(shaped.headers["Message-ID"]).toMatch(/^<autogen-\d+-[0-9a-f]{16}@cf-gitea\.example\.org>$/);
    expect(shaped.text).toBe("Hi Alice,");
  });

  it("permanent (resend without key): failed + last_error, NO throw", async () => {
    const e = mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: undefined });
    const { mailId } = await enqueueMailOutbox(e, DRAFT);
    const outcome = await processMailOutbox(e, { kind: "mail-outbox", mailId });
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
    expect(outcome.error).toContain("MAIL_PROVIDER_API_KEY");
    const stored = await row(mailId);
    expect(stored.status).toBe("failed");
    expect(stored.attempts).toBe(1);
  });

  it("transient (5xx): records the attempt and THROWS; the redelivery then succeeds", async () => {
    const failingFetch: typeof fetch = () => Promise.resolve(new Response("boom", { status: 500 }));
    const e = mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k" });
    const { mailId } = await enqueueMailOutbox(e, DRAFT);

    await expect(
      processMailOutbox(e, { kind: "mail-outbox", mailId }, { fetchImpl: failingFetch }),
    ).rejects.toBeInstanceOf(MailTransientError);
    let stored = await row(mailId);
    expect(stored.status).toBe("sending"); // the claim holds for the retry
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toContain("resend: status 500");

    // The redelivery (fresh options) succeeds — crash/retry recovery.
    const ok = await processMailOutbox(
      { ...e, MAIL_PROVIDER: "dummy" },
      { kind: "mail-outbox", mailId },
    );
    expect(ok).toEqual({ kind: "sent" });
    stored = await row(mailId);
    expect(stored.status).toBe("sent");
    expect(stored.attempts).toBe(2);
  });

  it("the attempt budget settles an exhausted 'sending' row failed (no perpetual in-flight)", async () => {
    const e = mailEnv();
    const { mailId } = await enqueueMailOutbox(e, DRAFT);
    await db()
      .update(emailOutbox)
      .set({ status: "sending", attempts: MAIL_MAX_ATTEMPTS })
      .where(eq(emailOutbox.id, mailId));
    expect(await processMailOutbox(e, { kind: "mail-outbox", mailId })).toEqual({ kind: "noop" });
    const stored = await row(mailId);
    expect(stored.status).toBe("failed");
    expect(stored.lastError).toContain("attempt budget exhausted");
  });

  it("a missing row is a noop (the purge race)", async () => {
    const e = mailEnv();
    expect(await processMailOutbox(e, { kind: "mail-outbox", mailId: 424242 })).toEqual({
      kind: "noop",
    });
  });
});

describe("the repo-tasks arm adapter", () => {
  it("isMailOutboxMessage guards the shape", () => {
    expect(isMailOutboxMessage({ kind: "mail-outbox", mailId: 3 })).toBe(true);
    expect(isMailOutboxMessage({ kind: "mail-outbox", mailId: 0 })).toBe(false);
    expect(isMailOutboxMessage({ kind: "mail-outbox", mailId: 1.5 })).toBe(false);
    expect(isMailOutboxMessage({ kind: "other", mailId: 3 })).toBe(false);
    expect(isMailOutboxMessage({ kind: "mail-outbox" })).toBe(false);
    expect(isMailOutboxMessage("mail-outbox")).toBe(false);
  });

  it("runMailOutboxArm: outcomes ack; a transient throw retries", async () => {
    const e = mailEnv();
    const { mailId } = await enqueueMailOutbox(e, DRAFT);

    const acked: number[] = [];
    const retried: number[] = [];
    const message = (id: number): Message =>
      ({
        id: String(id),
        ack: () => acked.push(id),
        retry: () => retried.push(id),
        timestamp: new Date(),
        body: { kind: "mail-outbox", mailId: id },
        attempts: 1,
      });

    await runMailOutboxArm(e, { kind: "mail-outbox", mailId }, message(1));
    expect(acked).toEqual([1]);

    // A malformed body never reaches the arm here (the guard does), but a
    // transient failure retries: permanent → ack (terminal), transient →
    // retry. Drive the permanent case through an armed resend without key.
    const e2 = mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: undefined });
    const { mailId: permId } = await enqueueMailOutbox(e2, { ...DRAFT, dedupeKey: null });
    await runMailOutboxArm(e2, { kind: "mail-outbox", mailId: permId }, message(2));
    expect(acked).toEqual([1, 2]);

    // Transient: force the failure via a fake fetch that 500s forever.
    const e3 = mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k" });
    const { mailId: tranId } = await enqueueMailOutbox(e3, { ...DRAFT, dedupeKey: null });
    await runMailOutboxArm(
      e3,
      { kind: "mail-outbox", mailId: tranId },
      message(3),
      { fetchImpl: () => Promise.resolve(new Response("down", { status: 500 })) },
    );
    expect(retried).toEqual([3]);
    expect((await row(tranId)).status).toBe("sending");
  });
});
