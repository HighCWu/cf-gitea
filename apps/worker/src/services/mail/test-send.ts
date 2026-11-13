/**
 * The admin test mail (specs/email-outbound.md §2.6-adjacent surface; the
 * census B-69 arm) — the port of upstream `SendTestMail`
 * (gitea/routers/web/admin/config.go:29-41 → services/mailer/mail.go:41-47):
 * the admin config page's rider POST triggers one message to a caller-supplied
 * address over the configured mailer, so the operator can confirm the send
 * path end to end.
 *
 * ## The send is DIRECT, not outboxed
 *
 * Upstream's notify mail rides the mail queue (`SendAsync` → the in-process
 * WorkerPoolQueue, mailer.go:19,48-63); the test mail does NOT — mail.go:45
 * calls `sender_service.Send(sender, …)` synchronously in the handler, and
 * nothing records the attempt. Ours mirrors the bypass: `sendTestMail`
 * resolves the transport and awaits it in the caller's context — NO
 * `email_outbox` row, no queue message (the ledger does not carry the test;
 * the flash response is the only outcome surface, exactly upstream's). The
 * message SHAPE is the landed outbox's (`shapeOutgoingMail` — subject
 * sanitize + `MAIL_SUBJECT_PREFIX` prepend, the auto Message-ID, the
 * X-Auto-Response-Suppress/Date headers, the html+text halves over the
 * plain-text body), so the test exercises the same wire bytes a queued mail
 * produces.
 *
 * ## The no-mailer posture is SILENT SUCCESS
 *
 * mail.go:44-46: `if setting.MailService == nil { return nil }` — with no
 * mailer configured the handler reports SUCCESS ("A testing email has been
 * sent to …"); the form is merely unrendered (config.tmpl:192's
 * `{{if .MailerEnabled}}` wrap). Ours: `MAIL_ENABLED !== "true"` (the SPEC
 * §5.1 strict-polarity master gate, register-notify.ts:95's semantics)
 * returns `disabled`, and the handler maps it to the SAME success flash —
 * silent success, never a refusal.
 *
 * ## The two failure arms upstream surfaces in the flash
 *
 *   - unparseable FROM — sender.go:25-27's `errors.New("no FROM specified")`
 *     (byte-verbatim; the mailer is armed but `MAIL_FROM` carries no address);
 *   - no/invalid recipient — the To header never sets (ToMessage's
 *     `_ = msg.SetAddrHeader("To", m.To)` ignores go-mail's parse error), so
 *     sender.go:20's `m.GetRecipients()` fails with go-mail v0.8.1's
 *     `ErrNoRcptAddresses` (msg.go:38, "no recipient addresses set" — read
 *     from the module source at the pin). Our recipient check is the bare
 *     address form (the form input is `type=email`; upstream's
 *     mail.ParseAddress additionally accepts display-name forms — a
 *     hand-crafted display-name To rides this same failed arm here, recorded
 *     as the check's shape). Transport failures (a provider 4xx/5xx or
 *     network throw) surface through the same arm with the error text — the
 *     direct send has NO retry leg (the queue's MailTransientError signal
 *     never enters; upstream's synchronous SMTP send has none either).
 */

import { parseMailFrom, shapeOutgoingMail } from "./message";
import { resolveTransport, type MailTransportEnv } from "./transport";

/** Upstream mail.go:45 — the test mail's subject AND body are this one
 *  string (sender_service.NewMessage(email, "Gitea Test Email!", "Gitea Test
 *  Email!")). */
export const GITEA_TEST_EMAIL_TEXT = "Gitea Test Email!";

/** The env slice the direct send reads — the armed gate + the sender
 *  identity + the shaping inputs + the transport selection. No binding: the
 *  direct send touches no D1 row and no queue. */
export interface TestMailEnv extends MailTransportEnv {
  /** The SPEC §5.1 master gate — only the exact "true" arms the senders. */
  MAIL_ENABLED?: string;
  /** The sender identity (upstream MailService.FromName/FromEmail). */
  MAIL_FROM?: string;
  /** The subject prepend (shapeOutgoingMail's read — outbox.ts:213). */
  MAIL_SUBJECT_PREFIX?: string;
  /** The Message-ID domain input (appDomainFromAppUrl). */
  APP_URL?: string;
}

export type TestMailOutcome =
  /** MAIL_ENABLED !== "true" — upstream's MailService == nil nil return
   *  (mail.go:44-46); the handler maps this to the SUCCESS flash. */
  | { outcome: "disabled" }
  /** The transport accepted the message. */
  | { outcome: "sent" }
  /** The send failed for cause — the error text feeds the failure flash
   *  (upstream config.go:33-35 embeds it via %v). */
  | { outcome: "failed"; error: string };

/**
 * The bare-address recipient check — the pragmatic net/mail stand-in the
 * tree already uses for upstream's ValidateEmail (misc-t3.ts validateEmail
 * family): printable-ASCII only, exactly one @, non-empty local/domain with
 * sane lengths. Upstream's arm here is coarser (any unparseable To lands in
 * the same go-mail ErrNoRcptAddresses failure); ours refuses the same
 * class of input into the same failed-flash arm.
 */
export function isValidTestMailRecipient(email: string): boolean {
  if (email === "" || /[^\x21-\x7e]/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 255) return false;
  return true;
}

/**
 * `SendTestMail`'s send half (mail.go:41-47) over the landed transport +
 * shaping: gate → FROM parse → recipient parse → shape → direct send.
 * Never throws — every failure mode resolves into `failed` with its error
 * text (the handler's flash embeds it), the direct-send posture's
 * synchronous analogue of upstream's err return.
 */
export async function sendTestMail(
  env: TestMailEnv,
  email: string,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TestMailOutcome> {
  // mail.go:44-46 — no mailer configured: return nil (the handler's success
  // flash fires; upstream's form is merely unrendered for this posture).
  if (env.MAIL_ENABLED !== "true") return { outcome: "disabled" };

  // sender.go:25-27 — the FROM fold: `if len(froms) == 0 { return
  // errors.New("no FROM specified") }`. NewMessage reads
  // MailService.FromName/FromEmail; ours reads the parseable MAIL_FROM.
  const from = parseMailFrom(env.MAIL_FROM ?? "");
  if (from === null) return { outcome: "failed", error: "no FROM specified" };

  // sender.go:20's GetRecipients arm — the To header never set (go-mail's
  // ignored SetAddrHeader parse error) fails with ErrNoRcptAddresses,
  // "no recipient addresses set" (go-mail v0.8.1 msg.go:38).
  if (!isValidTestMailRecipient(email)) {
    return { outcome: "failed", error: "no recipient addresses set" };
  }

  const outgoing = shapeOutgoingMail(
    {
      fromAddress: from.address,
      fromDisplayName: from.displayName,
      toAddr: email,
      replyTo: null,
      subject: GITEA_TEST_EMAIL_TEXT,
      bodyHtml: GITEA_TEST_EMAIL_TEXT,
      headers: null,
    },
    { subjectPrefix: env.MAIL_SUBJECT_PREFIX, appUrl: env.APP_URL, now: options.now },
  );
  try {
    // Resolution INSIDE the try: the provider-less config error
    // (resolveTransport's MailPermanentError) is a send failure like any
    // other — it feeds the flash, never the throw path (the direct send
    // never throws; the header's contract).
    const transport = resolveTransport(env, { fetchImpl: options.fetchImpl });
    await transport.send(outgoing);
  } catch (error) {
    // The direct send has no retry leg — every transport failure (a
    // MailPermanentError, a MailTransientError, or a provider-less config
    // error) resolves into the failed arm with its message, exactly where
    // upstream's synchronous send error lands (config.go:33-35).
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  return { outcome: "sent" };
}
