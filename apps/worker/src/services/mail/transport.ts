/**
 * The mail transport interface + providers (specs/email-outbound.md §3.2) —
 * the storage-service-layer pattern over the send leg: callers (the outbox
 * consumer) never see the provider. This is the port of upstream's
 * `Sender` seam (gitea/services/mailer/sender/sender.go:11-13) with the
 * protocol selection of services/mailer/mailer.go:37-44 reduced to the two
 * transports the platform can host:
 *
 *   - `dummy`  — upstream's DummySender (sender/dummy.go:15-23): render,
 *     log, succeed. The default and the test arm.
 *   - `resend` — the HTTP relay arm (the DECISION RECORD's (a)): one JSON
 *     POST to the provider, the API key a wrangler secret
 *     (`MAIL_PROVIDER_API_KEY` — names only in config, never values).
 *
 * The raw-socket SMTP and sendmail transports are platform-impossible
 * (sender/smtp.go:40 `net.Dial`; sendmail execs a binary) — the decision
 * record's premise, not an omission. Postmark/SendGrid are future provider
 * arms of this same interface; adding one touches this file only.
 *
 * Failure taxonomy (SPEC §3.3 — the deliberate divergence ledger entry):
 * `MailPermanentError` (provider 4xx — invalid address, unverified domain,
 * schema rejection) records `failed` and acks; `MailTransientError`
 * (network throw, 429, 5xx) propagates out of the consumer arm so the
 * queue's native retry applies, bounded by the repo-tasks `max_retries`,
 * then the DLQ — where upstream's mail queue is terminal-on-failure
 * (mailer.go:52-58 logs and drops), a throw is the only retry mechanism a
 * queue consumer has.
 */

import type { OutgoingMail } from "./message";

/** One transport = one provider. `send` resolves when the provider accepted
 *  the message and throws only the two typed errors below. */
export interface MailTransport {
  readonly provider: string;
  send(mail: OutgoingMail): Promise<void>;
}

/** Provider rejected the message for cause — terminal (SPEC §3.3). */
export class MailPermanentError extends Error {}

/** Provider/network hiccough — worth a queue retry (SPEC §3.3). */
export class MailTransientError extends Error {}

/** Upstream DummySender parity: render already happened; log and succeed. */
export class DummyTransport implements MailTransport {
  readonly provider = "dummy";
  /** Recorded mails — the test assertion surface (spyQueue posture). */
  readonly sent: OutgoingMail[] = [];

  send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
    console.debug(
      `[mail:dummy] From: ${mail.from} To: ${mail.to} Subject: ${mail.subject}`,
    );
    return Promise.resolve();
  }
}

/** The resend HTTP relay arm. Base URL overridable via `MAIL_API_BASE`
 *  (SPEC §6 — the test/diagnostic override). */
export class ResendTransport implements MailTransport {
  readonly provider = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.resend.com",
  ) {}

  async send(mail: OutgoingMail): Promise<void> {
    // The provider's request schema: {from, to[], subject, html?, text?,
    // reply_to?, headers?}. The X-Gitea-*/Message-ID header family rides the
    // provider's custom-headers map.
    const body: Record<string, unknown> = {
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    };
    if (mail.replyTo !== null) body.reply_to = mail.replyTo;
    if (Object.keys(mail.headers).length > 0) body.headers = mail.headers;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new MailTransientError(
        `resend: request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const statusClass = Math.trunc(response.status / 100);
    if (statusClass === 2) return;
    const excerpt = (await response.text().catch(() => "")).slice(0, 1024);
    const message = `resend: status ${response.status}: ${excerpt}`;
    throw response.status === 429 || statusClass === 5
      ? new MailTransientError(message)
      : new MailPermanentError(message);
  }
}

/** The env slice the factory reads (SPEC §6). */
export interface MailTransportEnv {
  MAIL_PROVIDER?: string;
  MAIL_PROVIDER_API_KEY?: string;
  MAIL_API_BASE?: string;
}

/**
 * The `mailer.go:37-44` protocol switch, reduced: `dummy` (the default —
 * including unknown values: an unknown PROVIDER must never silently become
 * a REAL sender) and `resend`. `resend` without a key fails the send with
 * a MailPermanentError naming the missing config (upstream Fatal's at boot
 * on a malformed mailer section, mailer.go:183-184; we have no boot step,
 * so the row's `failed` + `last_error` is the per-row analogue) — arming
 * the arm is the three-var+secret contract of SPEC §5.1.
 */
export function resolveTransport(env: MailTransportEnv, options?: { fetchImpl?: typeof fetch }): MailTransport {
  const provider = env.MAIL_PROVIDER === undefined || env.MAIL_PROVIDER === "" ? "dummy" : env.MAIL_PROVIDER;
  if (provider === "resend") {
    if (env.MAIL_PROVIDER_API_KEY === undefined || env.MAIL_PROVIDER_API_KEY === "") {
      throw new MailPermanentError("resend: MAIL_PROVIDER_API_KEY is not set (wrangler secret put MAIL_PROVIDER_API_KEY)");
    }
    return new ResendTransport(env.MAIL_PROVIDER_API_KEY, options?.fetchImpl, env.MAIL_API_BASE || "https://api.resend.com");
  }
  return new DummyTransport();
}
