/**
 * The SMTP transport pins (census B-66) — the parked platform probes
 * (the /tmp/b66-parked SmtpConn harness + the TLS-attribution probes)
 * restored as the real transport battery. Every socket pin runs over a
 * REAL TCP connection: the transport dials workerd's cloudflare:sockets
 * connect() to the strict stub listeners that vitest's globalSetup starts
 * on the Node side of the pool (src/test/mail-smtp-stubs.globalsetup.ts —
 * ephemeral ports via inject; no external network, no DNS, deterministic).
 * The stubs assert the exact wire bytes (MAIL FROM / RCPT TO lines, the
 * AUTH PLAIN token, the BODY= params, the dot-unstuffed DATA payload) — a
 * byte mismatch is a 5xx reply the pin's expect sees.
 *
 * Sections: (1) the session-ladder pins over real sockets, (2) the
 * MAIL_SMTP_* config-resolution pins (mailer.go:123-151's inference),
 * (3) the RFC 822 wire-format unit pins (the go-mail v0.8.1 analogue),
 * (4) the outbox-consumer end-to-end pins over the real socket + real D1.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, inject, vi } from "vitest";

import { emailOutbox } from "../../db/schema";
import { enqueueMailOutbox, processMailOutbox, type MailOutboxEnv } from "./outbox";
import { shapeOutgoingMail, type OutgoingMail } from "./message";
import {
  SmtpTransport,
  buildRfc822Message,
  dotEncode,
  resolveSmtpOptions,
  sanitizeEmailAddress,
  type SmtpDial,
  type SmtpSocket,
  type SmtpTransportOptions,
} from "./smtp-transport";
import { MailPermanentError, MailTransientError, resolveTransport } from "./transport";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

/** The globalSetup-provided stub port map. */
function stub(name: string): number {
  const ports = inject("mailSmtpStubs");
  if (ports === undefined || ports[name] === undefined) {
    throw new Error(
      `SMTP stub ${name} missing — vitest.config.ts must register src/test/mail-smtp-stubs.globalsetup.ts`,
    );
  }
  return ports[name];
}

/** A transport wired to one stub listener (the dial seam omitted → the
 *  REAL cloudflare:sockets connect() runs). */
function transportTo(name: string, over: Partial<SmtpTransportOptions> = {}): SmtpTransport {
  return new SmtpTransport({
    protocol: "smtp",
    addr: "127.0.0.1",
    port: String(stub(name)),
    user: "smtp-user",
    password: "smtp-pass",
    enableHelo: true,
    heloHostname: "cf-gitea.local",
    envelopeFrom: "",
    ...over,
  });
}

/** The shaped message every wire pin sends (carries the dot-stuffing
 *  sentinel line and the multipart halves the plain stub asserts). */
const shaped = (): OutgoingMail =>
  shapeOutgoingMail(
    {
      fromAddress: "noreply@example.com",
      fromDisplayName: "Gitea",
      toAddr: "alice@example.org",
      replyTo: null,
      subject: "Wire pin",
      bodyHtml: "<p>Hi <b>Alice</b>.</p>\n<p>.dotline</p>",
      headers: null,
    },
    { now: new Date(0), appUrl: "https://cf-gitea.example.org" },
  );

// ---------------------------------------------------------------------------
// The in-memory scripted socket — the TLS ladder pins' dial seam (see the
// TLS note in the stub suite: no local real-TLS listener can be trusted).
// ---------------------------------------------------------------------------

interface FakeScript {
  greeting?: string[];
  /** The reply lines for one command (the caller adds CRLFs). */
  reply(line: string): string[];
  /** The script the socket's startTls swaps to (the post-TLS half). */
  postTls?: FakeScript;
}

function fakeSocket(initial: FakeScript): {
  socket: SmtpSocket;
  sni: () => string | undefined;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let current: FakeScript = initial;
  let sni: string | undefined;
  let collecting = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const line of current.greeting ?? []) {
        controller.enqueue(encoder.encode(`${line}\r\n`));
      }
    },
  });
  const socket: SmtpSocket = {
    readable,
    writable: new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        const lines = decoder.decode(chunk).split("\r\n");
        if (lines[lines.length - 1] === "") lines.pop();
        for (const line of lines) {
          if (collecting) {
            if (line === ".") {
              collecting = false;
              controller.enqueue(encoder.encode("250 queued\r\n"));
            }
            continue;
          }
          if (line === "DATA") {
            collecting = true;
            controller.enqueue(encoder.encode("354 go\r\n"));
            continue;
          }
          for (const replyLine of current.reply(line)) {
            controller.enqueue(encoder.encode(`${replyLine}\r\n`));
          }
        }
      },
    }),
    opened: Promise.resolve({ remoteAddress: "fake" }),
    startTls(options) {
      sni = options?.expectedServerHostname;
      if (current.postTls === undefined) throw new Error("fake socket: no post-TLS script");
      current = current.postTls;
      return Promise.resolve(socket);
    },
    close: () => Promise.resolve(),
  };
  return { socket, sni: () => sni };
}

async function rejectsClass<T extends Error>(
  run: () => Promise<unknown>,
  errorClass: new (message: string) => T,
  messagePart?: string,
): Promise<T> {
  let caught: unknown;
  try {
    await run();
    expect.unreachable("the send should have failed");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(errorClass);
  const typed = caught as T;
  if (messagePart !== undefined) expect(typed.message).toContain(messagePart);
  return typed;
}

// ---------------------------------------------------------------------------
describe("SMTP transport over the real sockets (the B-66 ladder pins)", () => {
  it("walks the plaintext ladder: EHLO → AUTH PLAIN (exact token) → envelope bytes → dot-stuffed DATA", async () => {
    await transportTo("plain").send(shaped());
  });

  it("walks the AUTH LOGIN prompt ladder (smtp_auth.go LoginAuth)", async () => {
    await transportTo("login").send(shaped());
  });

  it("TLS ladder logic over the scripted dial: starttls posture, SNI = SMTP_ADDR, post-TLS re-EHLO feeds AUTH", async () => {
    // No local real-TLS stub can exist (workerd's verifier rejects every
    // self-signed cert — see the stub suite's TLS note); the TLS *ladder*
    // pins run over the in-memory scripted socket, the same seam shape as
    // the relay arm's fetchImpl. Real-CA TLS is probe-verified in
    // production posture (smtp.gmail.com:465 — the landing record).
    const preTls: FakeScript = {
      greeting: ["220 fake ESMTP"],
      // Deliberately NO AUTH here: the mechanism must resolve from the
      // post-TLS EHLO (Go's StartTLS trailing c.ehlo()).
      reply: (line) => {
        if (line.startsWith("EHLO")) return ["250-fake", "250 STARTTLS"];
        if (line === "STARTTLS") return ["220 go"];
        return ["503 out of phase"];
      },
      postTls: {
        reply: (line) => {
          if (line.startsWith("EHLO")) return ["250-fake", "250 AUTH PLAIN LOGIN"];
          if (line.startsWith("AUTH PLAIN")) return ["235 ok"];
          if (line.startsWith("MAIL FROM")) return ["250 ok"];
          if (line.startsWith("RCPT TO")) return ["250 ok"];
          if (line === "QUIT") return ["221 bye"];
          return ["250 ok"];
        },
      },
    };
    const fake = fakeSocket(preTls);
    const dialLog: { address: string; secureTransport: string }[] = [];
    const dial: SmtpDial = (address, secureTransport) => {
      dialLog.push({ address, secureTransport });
      return Promise.resolve(fake.socket);
    };
    await new SmtpTransport(
      {
        protocol: "smtp+starttls",
        addr: "smtp.example.net",
        port: "587",
        user: "smtp-user",
        password: "smtp-pass",
        enableHelo: true,
        heloHostname: "cf-gitea.local",
        envelopeFrom: "",
      },
      dial,
    ).send(shaped());
    expect(dialLog).toEqual([{ address: "smtp.example.net:587", secureTransport: "starttls" }]);
    expect(fake.sni()).toBe("smtp.example.net");
  });

  it("smtps ladder logic over the scripted dial: implicit TLS from byte 0", async () => {
    const script: FakeScript = {
      greeting: ["220 fake ESMTP"],
      reply: (line) => {
        if (line.startsWith("EHLO")) return ["250-fake", "250 AUTH PLAIN LOGIN"];
        if (line.startsWith("AUTH PLAIN")) return ["235 ok"];
        if (line.startsWith("MAIL FROM")) return ["250 ok"];
        if (line.startsWith("RCPT TO")) return ["250 ok"];
        if (line === "QUIT") return ["221 bye"];
        return ["250 ok"];
      },
    };
    const fake = fakeSocket(script);
    const dialLog: { address: string; secureTransport: string }[] = [];
    const dial: SmtpDial = (address, secureTransport) => {
      dialLog.push({ address, secureTransport });
      return Promise.resolve(fake.socket);
    };
    await new SmtpTransport(
      {
        protocol: "smtps",
        addr: "smtp.example.net",
        port: "465",
        user: "smtp-user",
        password: "smtp-pass",
        enableHelo: true,
        heloHostname: "cf-gitea.local",
        envelopeFrom: "",
      },
      dial,
    ).send(shaped());
    expect(dialLog).toEqual([{ address: "smtp.example.net:465", secureTransport: "on" }]);
  });

  it("falls back EHLO → HELO on a 500 and proceeds with the empty extension map", async () => {
    await transportTo("helo-fallback", { user: "", password: "" }).send(shaped());
  });

  it("warns and falls back to plaintext when STARTTLS is not advertised (upstream's log.Warn arm)", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await transportTo("starttls-missing", { protocol: "smtp+starttls", user: "", password: "" }).send(shaped());
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("\n")).toContain(
      "StartTLS requested, but SMTP server does not support it; falling back to regular SMTP",
    );
  });

  it("skips AUTH when no credentials are configured (upstream's len(User)==0 arm)", async () => {
    await transportTo("plain", { user: "", password: "" }).send(shaped());
  });

  it("refuses verbatim when credentials are set but the server advertises no AUTH", async () => {
    await rejectsClass(
      () => transportTo("no-auth-offered").send(shaped()),
      MailPermanentError,
      "SMTP server does not support AUTH, but credentials provided",
    );
  });

  it("refuses the CRAM-MD5-only offer instead of silently sending unauthenticated", async () => {
    await rejectsClass(
      () => transportTo("cram-only").send(shaped()),
      MailPermanentError,
      "CRAM-MD5",
    );
  });

  it("maps an AUTH 535 to MailPermanentError with upstream's wrap", async () => {
    await rejectsClass(
      () => transportTo("auth-fail").send(shaped()),
      MailPermanentError,
      "failed to authenticate SMTP: 535",
    );
  });

  it("refuses an unknown AUTH LOGIN prompt with the verbatim fromServer text", async () => {
    await rejectsClass(
      () => transportTo("login-unknown-prompt").send(shaped()),
      MailPermanentError,
      "unknown fromServer: GuessWho:",
    );
  });

  it("maps a 451 MAIL FROM to MailTransientError (the queue-retry class)", async () => {
    await rejectsClass(
      () => transportTo("mail-transient", { user: "", password: "" }).send(shaped()),
      MailTransientError,
      "451",
    );
  });

  it("maps a 550 RCPT TO to MailPermanentError", async () => {
    await rejectsClass(
      () => transportTo("rcpt-permanent", { user: "", password: "" }).send(shaped()),
      MailPermanentError,
      "550",
    );
  });

  it("maps a 451 on the DATA terminator to MailTransientError", async () => {
    await rejectsClass(
      () => transportTo("data-transient", { user: "", password: "" }).send(shaped()),
      MailTransientError,
      "451",
    );
  });

  it("maps a 421 greeting to MailTransientError", async () => {
    await rejectsClass(
      () => transportTo("greeting-transient", { user: "", password: "" }).send(shaped()),
      MailTransientError,
      "421",
    );
  });

  it("maps a 554 greeting to MailPermanentError", async () => {
    await rejectsClass(
      () => transportTo("greeting-permanent", { user: "", password: "" }).send(shaped()),
      MailPermanentError,
      "554",
    );
  });

  it("adds BODY=8BITMIME SMTPUTF8 to MAIL FROM exactly when advertised (Go Client.Mail's params)", async () => {
    await transportTo("eightbit", { user: "", password: "" }).send(shaped());
  });

  it("sends ENVELOPE_FROM as the envelope sender (upstream OverrideEnvelopeFrom)", async () => {
    await transportTo("envelope-from", { user: "", password: "", envelopeFrom: "envelope@example.com" }).send(shaped());
  });
});

// ---------------------------------------------------------------------------
describe("resolveSmtpOptions (the mailer.go:123-151 inference + :201-212 envelope)", () => {
  const base = { MAIL_SMTP_ADDR: "smtp.example.net" };

  it("infers the protocol from the port (25/587) and keeps an unknown port at smtps", () => {
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_PORT: "25" })).toMatchObject({ protocol: "smtp", port: "25" });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_PORT: "587" })).toMatchObject({
      protocol: "smtp+starttls",
      port: "587",
    });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_PORT: "2525" })).toMatchObject({ protocol: "smtps", port: "2525" });
  });

  it("infers the port from the protocol (25/465/587) and falls through to smtps:465 when BOTH are unset", () => {
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_PROTOCOL: "smtp" })).toMatchObject({ protocol: "smtp", port: "25" });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_PROTOCOL: "smtps" })).toMatchObject({ protocol: "smtps", port: "465" });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_PROTOCOL: "smtp+starttls" })).toMatchObject({
      protocol: "smtp+starttls",
      port: "587",
    });
    expect(resolveSmtpOptions({ ...base })).toMatchObject({ protocol: "smtps", port: "465" });
  });

  it("refuses smtp+unix and unknown protocols with the platform reason", () => {
    expect(() => resolveSmtpOptions({ ...base, MAIL_SMTP_PROTOCOL: "smtp+unix" })).toThrow(MailPermanentError);
    expect(() => resolveSmtpOptions({ ...base, MAIL_SMTP_PROTOCOL: "sendmail" })).toThrow(MailPermanentError);
  });

  it("refuses a missing SMTP_ADDR", () => {
    expect(() => resolveSmtpOptions({})).toThrow(MailPermanentError);
  });

  it("reads the HELO pair with upstream's defaults (ENABLE_HELO on, os.Hostname → 'localhost' adaptation)", () => {
    expect(resolveSmtpOptions({ ...base })).toMatchObject({ enableHelo: true, heloHostname: "localhost" });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_ENABLE_HELO: "false" })).toMatchObject({ enableHelo: false });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_HELO_HOSTNAME: "mx.example.net" })).toMatchObject({
      heloHostname: "mx.example.net",
    });
  });

  it("reads ENVELOPE_FROM with the upstream 'none' arm and the invalid-value refusal", () => {
    expect(resolveSmtpOptions({ ...base })).toMatchObject({ envelopeFrom: "" });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_ENVELOPE_FROM: "none" })).toMatchObject({ envelopeFrom: "" });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_ENVELOPE_FROM: "envelope@example.com" })).toMatchObject({
      envelopeFrom: "envelope@example.com",
    });
    expect(resolveSmtpOptions({ ...base, MAIL_SMTP_ENVELOPE_FROM: "Envelope <envelope@example.com>" })).toMatchObject({
      envelopeFrom: "envelope@example.com",
    });
    expect(() => resolveSmtpOptions({ ...base, MAIL_SMTP_ENVELOPE_FROM: "not-an-address" })).toThrow(MailPermanentError);
  });
});

// ---------------------------------------------------------------------------
describe("the RFC 822 DATA payload (the go-mail v0.8.1 analogue)", () => {
  it("renders the go-mail header order: address headers, sorted generics, MIME tail", () => {
    const message = buildRfc822Message(
      {
        ...shaped(),
        replyTo: "reply@example.org",
        headers: {
          Date: "Thu, 01 Jan 1970 00:00:00 +0000",
          "Message-ID": "<autogen-1-2@example.org>",
          "X-Gitea-Zeta": "z",
          "X-Gitea-Alpha": "a",
        },
      },
      "BOUNDARY",
    );
    const order = [
      "From: Gitea <noreply@example.com>",
      "To: <alice@example.org>",
      "Reply-To: <reply@example.org>",
      "Date: Thu, 01 Jan 1970 00:00:00 +0000",
      "Message-ID: <autogen-1-2@example.org>",
      "Subject: Wire pin",
      "X-Gitea-Alpha: a", // the generics sort alphabetically (writeGenHeader)
      "X-Gitea-Zeta: z",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="BOUNDARY"',
    ];
    let last = -1;
    for (const header of order) {
      const at = message.indexOf(`${header}\r\n`);
      expect(at, header).toBeGreaterThan(last);
      last = at;
    }
    expect(message).toContain(`--BOUNDARY\r\nContent-Type: text/plain; charset=UTF-8`);
    expect(message.indexOf("Content-Type: text/plain")).toBeLessThan(message.indexOf("Content-Type: text/html"));
    expect(message.endsWith(`--BOUNDARY--\r\n`)).toBe(true);
  });

  it("Q-encodes non-ASCII subjects and display names; ASCII passes verbatim", () => {
    const ascii = buildRfc822Message(shaped(), "B");
    expect(ascii).toContain("Subject: Wire pin\r\n");
    const encoded = buildRfc822Message({ ...shaped(), subject: "Pinged á propòs" }, "B");
    expect(encoded).toContain("Subject: =?UTF-8?q?");
    expect(encoded).not.toContain("Subject: Pinged á");
    const namedFrom = buildRfc822Message({ ...shaped(), from: "Ädmin <noreply@example.com>" }, "B");
    expect(namedFrom).toContain("From: =?UTF-8?q?");
  });

  it("quoted-printable-encodes the parts (=, non-ASCII, trailing spaces protected)", () => {
    const message = buildRfc822Message(
      { ...shaped(), html: "<p>x á y</p>", text: "a = b " },
      "B",
    );
    expect(message).toContain("a =3D b=20");
    expect(message).toContain("x =C3=A1 y");
  });

  it("dot-encodes the payload: leading dots doubled, bare LF normalized, terminator appended", () => {
    expect(dotEncode("a\r\n.b\r\nc")).toBe("a\r\n..b\r\nc\r\n.\r\n");
    expect(dotEncode("a\n.b")).toBe("a\r\n..b\r\n.\r\n");
    expect(dotEncode(".")).toBe("..\r\n.\r\n");
  });

  it("sanitizes the envelope addresses (upstream sanitizeEmailAddress)", () => {
    expect(sanitizeEmailAddress("noreply@example.com")).toBe("noreply@example.com");
    expect(sanitizeEmailAddress("Gitea <noreply@example.com>")).toBe("noreply@example.com");
    expect(sanitizeEmailAddress("<noreply@example.com>")).toBe("noreply@example.com");
    expect(() => sanitizeEmailAddress("not-an-address")).toThrow(MailPermanentError);
  });

  it("the MAIL_PROVIDER=smtp switch value resolves the SMTP transport (unknown providers stay dummy)", () => {
    const smtp = resolveTransport({ MAIL_PROVIDER: "smtp", MAIL_SMTP_ADDR: "smtp.example.net" });
    expect(smtp.provider).toBe("smtp");
    expect(smtp).toBeInstanceOf(SmtpTransport);
    expect(resolveTransport({ MAIL_PROVIDER: "mystery" }).provider).toBe("dummy");
  });
});

// ---------------------------------------------------------------------------
describe("the outbox consumer over the real SMTP socket (end-to-end)", () => {
  beforeAll(async () => {
    if (env.TEST_MIGRATIONS === undefined) {
      throw new Error("TEST_MIGRATIONS binding missing");
    }
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM email_outbox").run();
  });

  const db = () => drizzle(env.DB);

  /** The outbox.test.ts row read (the `!` non-null through the helper —
   *  a missing row fails the pin's expect on the first field access). */
  const row = async (mailId: number) =>
    (await db().select().from(emailOutbox).where(eq(emailOutbox.id, mailId)).get())!;

  const DRAFT = {
    info: "UID: 7, registration notify",
    fromAddress: "noreply@example.com",
    fromDisplayName: "Gitea",
    toAddr: "alice@example.org",
    replyTo: null,
    subject: "Wire pin",
    bodyHtml: "<p>Hi <b>Alice</b>.</p>\n<p>.dotline</p>",
    headers: null,
    dedupeKey: "smtp-e2e:7",
  };

  function consumerEnv(name: string, over: Partial<MailOutboxEnv> = {}): MailOutboxEnv {
    return {
      DB: env.DB,
      APP_URL: "https://cf-gitea.example.org",
      MAIL_PROVIDER: "smtp",
      MAIL_SMTP_ADDR: "127.0.0.1",
      MAIL_SMTP_PORT: String(stub(name)),
      MAIL_SMTP_PROTOCOL: "smtp",
      MAIL_SMTP_USER: "smtp-user",
      MAIL_SMTP_PASSWORD: "smtp-pass",
      ...over,
    };
  }

  it("processMailOutbox delivers the row over the real socket and records sent", async () => {
    const queued = await enqueueMailOutbox({ DB: env.DB }, DRAFT);
    expect(queued.outcome).toBe("pending-unqueued"); // no queue binding: the row persists, no message
    const outcome = await processMailOutbox(consumerEnv("plain"), { kind: "mail-outbox", mailId: queued.mailId });
    expect(outcome).toEqual({ kind: "sent" });
    const stored = await row(queued.mailId);
    expect(stored?.status).toBe("sent");
    expect(stored?.sentAt).toBeInstanceOf(Date);
  });

  it("a permanent reply fails the row terminally (the RCPT 550 ladder)", async () => {
    const queued = await enqueueMailOutbox({ DB: env.DB }, DRAFT);
    const outcome = await processMailOutbox(
      consumerEnv("rcpt-permanent", { MAIL_SMTP_USER: "", MAIL_SMTP_PASSWORD: "" }),
      { kind: "mail-outbox", mailId: queued.mailId },
    );
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
    expect(outcome.error).toContain("550");
    const stored = await row(queued.mailId);
    expect(stored?.status).toBe("failed");
    expect(stored?.lastError).toContain("550");
  });

  it("a transient reply records the attempt and rethrows the queue-retry signal (the MAIL 451 ladder)", async () => {
    const queued = await enqueueMailOutbox({ DB: env.DB }, DRAFT);
    await rejectsClass(
      () =>
        processMailOutbox(
          consumerEnv("mail-transient", { MAIL_SMTP_USER: "", MAIL_SMTP_PASSWORD: "" }),
          { kind: "mail-outbox", mailId: queued.mailId },
        ),
      MailTransientError,
      "451",
    );
    const stored = await row(queued.mailId);
    expect(stored?.status).toBe("sending"); // the claim stays (crash-recovery re-claim arm)
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toContain("451");
  });

  it("a config fault (missing SMTP_ADDR) fails the row like a provider 4xx", async () => {
    const queued = await enqueueMailOutbox({ DB: env.DB }, DRAFT);
    const envWithoutAddr = { ...consumerEnv("plain"), MAIL_SMTP_ADDR: undefined };
    const outcome = await processMailOutbox(envWithoutAddr, { kind: "mail-outbox", mailId: queued.mailId });
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
    expect(outcome.error).toContain("MAIL_SMTP_ADDR");
    const stored = await row(queued.mailId);
    expect(stored?.status).toBe("failed");
  });
});
