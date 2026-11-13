/**
 * The admin test mail (services/mail/test-send.ts — the census B-69 arm) on
 * the real test D1: the gate posture (MAIL_ENABLED strict polarity — the
 * no-mailer silent-success input), the direct-send bypass (NO email_outbox
 * row, NO queue — upstream mail.go:45 calls sender_service.Send outside the
 * mail queue and records nothing), the wire bytes over the resend relay with
 * a fake fetch (no network, ever — outbox.test.ts's provider-contract
 * shape), and the three failure arms verbatim (no FROM specified —
 * sender.go:27; no recipient addresses set — go-mail v0.8.1 msg.go:38's
 * ErrNoRcptAddresses; the transport errors surfaced untried).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { emailOutbox } from "../../db/schema";
import { GITEA_TEST_EMAIL_TEXT, isValidTestMailRecipient, sendTestMail, type TestMailEnv } from "./test-send";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM email_outbox").run();
});

/** The armed base env (the canonical self-host values; the test flips the
 *  MAIL_* fields per arm). */
function mailEnv(overrides: Partial<TestMailEnv> = {}): TestMailEnv {
  return {
    MAIL_ENABLED: "true",
    MAIL_PROVIDER: "dummy",
    MAIL_FROM: "no-reply@test.local",
    MAIL_SUBJECT_PREFIX: "",
    MAIL_API_BASE: "",
    APP_URL: "https://test.local",
    ...overrides,
  };
}

const NOW = new Date("2026-11-13T12:00:00Z");

describe("the armed gate (upstream mail.go:44-46's MailService == nil nil return)", () => {
  it("disabled for every non-\"true\" MAIL_ENABLED (strict polarity) — the handler maps this arm to the SUCCESS flash", async () => {
    for (const mailEnabled of [undefined, "", "false", "TRUE", "1"]) {
      const outcome = await sendTestMail(mailEnv({ MAIL_ENABLED: mailEnabled }), "root@test.local");
      expect(outcome).toEqual({ outcome: "disabled" });
    }
  });

  it("armed rides on: the send proceeds (the polarity's positive arm)", async () => {
    const outcome = await sendTestMail(mailEnv(), "root@test.local");
    expect(outcome).toEqual({ outcome: "sent" });
  });
});

describe("the direct-send bypass (the outbox ledger does NOT carry the test)", () => {
  it("a successful test send writes NO email_outbox row and enqueues nothing", async () => {
    const outcome = await sendTestMail(mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k", MAIL_API_BASE: "https://relay.test" }), "root@test.local", {
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "sent" });
    const rows = await drizzle(env.DB).select({ id: emailOutbox.id }).from(emailOutbox).all();
    expect(rows).toEqual([]);
  });
});

describe("the wire shape (resend relay over a fake fetch — the shaped message bytes)", () => {
  function relayFetch(): typeof fetch & { bodies: string[] } {
    const impl = ((url: URL | RequestInfo, init?: RequestInit) => {
      // The relay only ever receives a string body here (JSON.stringify at
      // the transport) — capture the string, not a guess.
      impl.bodies.push(typeof init?.body === "string" ? init.body : "");
      void url;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch & { bodies: string[] };
    impl.bodies = [];
    return impl;
  }

  it("the relay carries the upstream test message: subject/body \"Gitea Test Email!\" (mail.go:45), the From bare form, the shaped headers", async () => {
    const fetchImpl = relayFetch();
    const outcome = await sendTestMail(
      mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k", MAIL_API_BASE: "https://relay.test" }),
      "root@test.local",
      { fetchImpl, now: NOW },
    );
    expect(outcome).toEqual({ outcome: "sent" });
    expect(fetchImpl.bodies.length).toBe(1);
    const body = JSON.parse(fetchImpl.bodies[0]!) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
      headers: Record<string, string>;
    };
    expect(body.from).toBe("no-reply@test.local"); // the MAIL_FROM parse — bare address form
    expect(body.to).toEqual(["root@test.local"]); // the single recipient (upstream's leak prevention)
    expect(body.subject).toBe(GITEA_TEST_EMAIL_TEXT); // no prefix configured
    expect(body.html).toBe(GITEA_TEST_EMAIL_TEXT); // the plain-text body IS the html half
    expect(body.text).toBe(GITEA_TEST_EMAIL_TEXT); // htmlToText over the tag-less body
    expect(body.headers["X-Auto-Response-Suppress"]).toBe("All");
    expect(body.headers["Message-ID"]).toMatch(/^<autogen-1794571200000-[0-9a-f]{16}@test\.local>$/);
    expect(body.headers["Date"]).toBe("Fri, 13 Nov 2026 12:00:00 +0000");
  });

  it("MAIL_SUBJECT_PREFIX prepends the shaped subject (ToMessage's prefix arm)", async () => {
    const fetchImpl = relayFetch();
    await sendTestMail(
      mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k", MAIL_API_BASE: "https://relay.test", MAIL_SUBJECT_PREFIX: "[cf-gitea]" }),
      "root@test.local",
      { fetchImpl, now: NOW },
    );
    const body = JSON.parse(fetchImpl.bodies[0]!) as { subject: string };
    expect(body.subject).toBe(`[cf-gitea] ${GITEA_TEST_EMAIL_TEXT}`);
  });

  it("MAIL_FROM with a display name renders the From display form (formatAddress)", async () => {
    const fetchImpl = relayFetch();
    await sendTestMail(
      mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k", MAIL_API_BASE: "https://relay.test", MAIL_FROM: "Forge <no-reply@test.local>" }),
      "root@test.local",
      { fetchImpl, now: NOW },
    );
    const body = JSON.parse(fetchImpl.bodies[0]!) as { from: string };
    expect(body.from).toBe("Forge <no-reply@test.local>");
  });
});

describe("the failure arms (config.go:33-35's %v embed)", () => {
  it("unparseable MAIL_FROM fails with sender.go:27's verbatim \"no FROM specified\"", async () => {
    for (const mailFrom of ["", "no-at-address"]) {
      const outcome = await sendTestMail(mailEnv({ MAIL_FROM: mailFrom }), "root@test.local");
      expect(outcome).toEqual({ outcome: "failed", error: "no FROM specified" });
    }
  });

  it("a missing/invalid recipient fails with go-mail v0.8.1's verbatim \"no recipient addresses set\" (ErrNoRcptAddresses, msg.go:38)", async () => {
    for (const recipient of ["", "junk", "a@b@c", "a b@test.local", "mé@lição.test", "@test.local", "local@", `${"x".repeat(65)}@test.local`]) {
      const outcome = await sendTestMail(mailEnv(), recipient);
      expect(outcome).toEqual({ outcome: "failed", error: "no recipient addresses set" });
    }
  });

  it("resend without its key fails with the transport's config error (the provider-less arm, untried)", async () => {
    const outcome = await sendTestMail(mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "" }), "root@test.local");
    expect(outcome).toEqual({
      outcome: "failed",
      error: "resend: MAIL_PROVIDER_API_KEY is not set (wrangler secret put MAIL_PROVIDER_API_KEY)",
    });
  });

  it("a provider 4xx surfaces in the failed arm with its status text (permanent — and the direct send has no retry leg anyway)", async () => {
    const outcome = await sendTestMail(
      mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k", MAIL_API_BASE: "https://relay.test" }),
      "root@test.local",
      { fetchImpl: () => Promise.resolve(new Response("unverified domain", { status: 403 })) },
    );
    expect(outcome).toEqual({ outcome: "failed", error: "resend: status 403: unverified domain" });
  });

  it("a provider 5xx ALSO lands in the failed arm (the transient's queue-retry signal never enters the direct send)", async () => {
    const outcome = await sendTestMail(
      mailEnv({ MAIL_PROVIDER: "resend", MAIL_PROVIDER_API_KEY: "k", MAIL_API_BASE: "https://relay.test" }),
      "root@test.local",
      { fetchImpl: () => Promise.resolve(new Response("down", { status: 500 })) },
    );
    expect(outcome).toEqual({ outcome: "failed", error: "resend: status 500: down" });
  });
});

describe("isValidTestMailRecipient (the bare-address check)", () => {
  it("accepts plain printable-ASCII single-@ addresses", () => {
    expect(isValidTestMailRecipient("root@test.local")).toBe(true);
    expect(isValidTestMailRecipient("first.last@sub.test.local")).toBe(true);
  });
  it("refuses empty, whitespace, non-ASCII, multi-@, and boundary-less forms", () => {
    expect(isValidTestMailRecipient("")).toBe(false);
    expect(isValidTestMailRecipient("a b@test.local")).toBe(false);
    expect(isValidTestMailRecipient("mé@lição.test")).toBe(false);
    expect(isValidTestMailRecipient("a@b@c")).toBe(false);
    expect(isValidTestMailRecipient("@test.local")).toBe(false);
    expect(isValidTestMailRecipient("local@")).toBe(false);
  });
});

describe("the table reset posture", () => {
  it("email_outbox starts every test empty and the module never writes it (equivalence: a known-good enqueue still lands)", async () => {
    // A control: the outbox lane itself still works (the test harness's own
    // sanity — the bypass above is a CHOICE, not a broken writer).
    const { enqueueMailOutbox } = await import("./outbox");
    const inserted = await enqueueMailOutbox(
      { DB: env.DB },
      {
        info: "control",
        fromAddress: "no-reply@test.local",
        fromDisplayName: "",
        toAddr: "root@test.local",
        replyTo: null,
        subject: "control",
        bodyHtml: "control",
        headers: null,
        dedupeKey: null,
      },
    );
    expect(inserted.outcome).toBe("pending-unqueued"); // no REPO_TASKS binding in the slice
    const rows = await drizzle(env.DB).select({ id: emailOutbox.id }).from(emailOutbox).all();
    expect(rows.length).toBe(1);
  });
});
