/**
 * The email outbox: producer + REPO_TASKS consumer arm
 * (specs/email-outbound.md §3.2, §4) — the webhook-delivery design (SPEC-0005
 * §3.6) applied to mail: the payload lives in the D1 `email_outbox` row, the
 * queue message carries only `{kind: "mail-outbox", mailId}`, so retries
 * read fresh state and the delivery log is complete regardless of queue
 * state. Upstream queues mail too (services/mailer/mailer.go:19,48-63) —
 * this is the upstream shape, hosted on the platform's queue instead of the
 * in-process WorkerPoolQueue.
 *
 * Producer (`enqueueMailOutbox`): one awaited INSERT (the dedupe arbiter on
 * `dedupe_key` settles trigger re-drives, SPEC §4.1), then the queue send
 * best-effort — a send failure is caught and logged and the row stays
 * `pending` (the issue-events seam posture: the durable source of truth
 * outlives the enqueue; a later enqueue replays safely).
 *
 * Consumer (`processMailOutbox`), per message:
 *   1. claim `status IN ('pending','sending') AND attempts < 5` →
 *      `status='sending', attempts+1` (0 rows ⇒ terminal or exhausted ⇒
 *      no-op ack; the 'sending' arm is crash recovery — a consumer that died
 *      mid-send leaves the row claimable, bounded by the same 5-attempt
 *      budget as the repo-tasks `max_retries`);
 *   2. shape the stored row (message.ts `shapeOutgoingMail` — the upstream
 *      `ToMessage` transforms run at SEND time so config
 *      (`MAIL_SUBJECT_PREFIX`) is read fresh per attempt, SPEC §4.2);
 *   3. hand it to the configured transport (transport.ts `resolveTransport`
 *      — the `mailer.go:37-44` protocol switch);
 *   4. record the outcome: `sent`+`sent_at`, or `failed`+`last_error` for a
 *      MailPermanentError (provider 4xx — terminal, acked, the upstream
 *      log-and-drop end state made durable), or rethrow a
 *      MailTransientError (429/5xx/network — the queue-retry signal, SPEC
 *      §3.3 divergence ledger).
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailOutbox } from "../../db/schema";
import { shapeOutgoingMail } from "./message";
import { MailPermanentError, MailTransientError, resolveTransport } from "./transport";

/** The attempt budget — mirrors the repo-tasks consumer's `max_retries: 5`
 *  (wrangler.jsonc); the crash-recovery re-claim (§ header) shares it. */
export const MAIL_MAX_ATTEMPTS = 5;

/** The only thing a producer puts on the queue. */
export interface MailOutboxMessage {
  kind: "mail-outbox";
  mailId: number;
}

/** Structural env slice (no new bindings — DB + REPO_TASKS landed). */
export interface MailOutboxEnv {
  DB: D1Database;
  REPO_TASKS?: Queue;
  APP_URL?: string;
  MAIL_SUBJECT_PREFIX?: string;
  MAIL_PROVIDER?: string;
  MAIL_PROVIDER_API_KEY?: string;
  MAIL_API_BASE?: string;
}

/** The stored draft — the shaped-but-unsanitized message (SPEC §4.2). */
export interface MailDraft {
  info: string;
  fromAddress: string;
  fromDisplayName: string;
  toAddr: string;
  replyTo: string | null;
  subject: string;
  bodyHtml: string;
  /** JSON `Record<string, string>` text, or null. */
  headers: string | null;
  dedupeKey: string | null;
}

/** Chained-cause unwrap (the user-accounts `errorText` pattern — drizzle
 *  wraps driver errors; the arbiter text may sit on any cause). */
function errorText(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text;
}

export type EnqueueOutcome =
  | { outcome: "queued"; mailId: number }
  | { outcome: "deduped"; mailId: number }
  | { outcome: "pending-unqueued"; mailId: number };

/**
 * Insert the draft and hand its id to the queue (SPEC §4.5 producer
 * posture). `dedupeKey` collisions resolve to the WINNER's existing row
 * (`deduped`) — the second trigger is an idempotent no-op, never an error.
 * A missing/broken queue binding leaves the row `pending-unqueued` (the
 * stranded-pending gap SPEC §4.5 records; the re-drive sweep is the
 * §1.3 follow-up).
 */
export async function enqueueMailOutbox(
  env: Pick<MailOutboxEnv, "DB" | "REPO_TASKS">,
  draft: MailDraft,
  options: { now?: Date } = {},
): Promise<EnqueueOutcome> {
  const now = options.now ?? new Date();
  let mailId: number;
  try {
    const inserted = await drizzle(env.DB)
      .insert(emailOutbox)
      .values({
        info: draft.info,
        fromAddress: draft.fromAddress,
        fromDisplayName: draft.fromDisplayName,
        toAddr: draft.toAddr,
        replyTo: draft.replyTo,
        subject: draft.subject,
        bodyHtml: draft.bodyHtml,
        headers: draft.headers,
        dedupeKey: draft.dedupeKey,
        createdAt: now,
      })
      .returning({ id: emailOutbox.id });
    mailId = inserted[0]!.id;
  } catch (error) {
    const text = errorText(error);
    if (text.includes("UNIQUE constraint failed") && text.includes("dedupe_key")) {
      const existing = await drizzle(env.DB)
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(eq(emailOutbox.dedupeKey, draft.dedupeKey!))
        .get();
      return { outcome: "deduped", mailId: existing?.id ?? -1 };
    }
    throw error;
  }

  const queue = env.REPO_TASKS;
  if (queue === undefined) {
    console.warn(`[mail] REPO_TASKS not bound; mail ${mailId} stays pending (no enqueue)`);
    return { outcome: "pending-unqueued", mailId };
  }
  try {
    await queue.send({ kind: "mail-outbox", mailId } satisfies MailOutboxMessage);
  } catch (error) {
    console.error(
      `[mail] queue send failed for mail ${mailId}; row stays pending:`,
      error instanceof Error ? error.message : String(error),
    );
    return { outcome: "pending-unqueued", mailId };
  }
  return { outcome: "queued", mailId };
}

export type ProcessOutcome = { kind: "noop" } | { kind: "sent" } | { kind: "failed"; error: string };

/** Cap a failure text for `last_error` (SPEC §5.3: 1 KiB). */
function clip(text: string): string {
  return text.length > 1024 ? text.slice(0, 1024) : text;
}

/**
 * The consumer for one `{mailId}` (SPEC §3.3 + the § header algorithm).
 * Resolves once the outcome is durably recorded (⇒ ack); throws
 * MailTransientError only for the queue-retry signal. Any other throw is a
 * could-not-persist condition — the arm's caller retries the message and
 * the claim's attempt budget bounds the loop.
 */
export async function processMailOutbox(
  env: MailOutboxEnv,
  message: MailOutboxMessage,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ProcessOutcome> {
  const db = drizzle(env.DB);
  const now = options.now ?? new Date();

  // Step 1 — the claim (pending fresh work, or crash recovery on a stuck
  // 'sending' within the attempt budget); 0 rows ⇒ nothing to do.
  const claimed = await db
    .update(emailOutbox)
    .set({ status: "sending", attempts: sql`${emailOutbox.attempts} + 1` })
    .where(
      sql`${emailOutbox.id} = ${message.mailId} AND ${emailOutbox.status} IN ('pending', 'sending') AND ${emailOutbox.attempts} < ${MAIL_MAX_ATTEMPTS}`,
    )
    .returning({ id: emailOutbox.id });
  if (claimed.length === 0) {
    // A claim that failed ONLY because the budget ran out (stuck 'sending')
    // settles terminal — the queue message is about to land in the DLQ, so
    // the row must never show a perpetual in-flight state (the webhook
    // sweep's rationale, made inline).
    await db
      .update(emailOutbox)
      .set({ status: "failed", lastError: `attempt budget exhausted (${MAIL_MAX_ATTEMPTS})` })
      .where(
        sql`${emailOutbox.id} = ${message.mailId} AND ${emailOutbox.status} = 'sending' AND ${emailOutbox.attempts} >= ${MAIL_MAX_ATTEMPTS}`,
      );
    return { kind: "noop" };
  }

  const row = await db.select().from(emailOutbox).where(eq(emailOutbox.id, message.mailId)).get();
  if (row === undefined) return { kind: "noop" };

  // Steps 2-3 — shape at send time, then the provider. Everything here is
  // typed: MailPermanentError (provider 4xx, or the missing-key config
  // error of SPEC §5.2/§6) settles `failed`; MailTransientError (429/5xx/
  // network) records the attempt and rethrows as the queue-retry signal;
  // an untyped error is treated as transient (conservative — the claim's
  // attempt budget bounds it either way).
  try {
    const transport = resolveTransport(env, { fetchImpl: options.fetchImpl });
    const outgoing = shapeOutgoingMail(row, {
      subjectPrefix: env.MAIL_SUBJECT_PREFIX,
      appUrl: env.APP_URL,
      now,
    });
    await transport.send(outgoing);
  } catch (error) {
    const text = clip(error instanceof Error ? error.message : String(error));
    if (error instanceof MailPermanentError) {
      await db
        .update(emailOutbox)
        .set({ status: "failed", lastError: text })
        .where(eq(emailOutbox.id, row.id));
      return { kind: "failed", error: text };
    }
    // Record the attempt, keep the claim — the redelivery re-claims within
    // the budget (step 1's 'sending' arm), and a final exhaustion settles
    // terminal there.
    await db
      .update(emailOutbox)
      .set({ lastError: text })
      .where(eq(emailOutbox.id, row.id));
    if (!(error instanceof MailTransientError)) throw new MailTransientError(text);
    throw error;
  }

  // Step 4 — success.
  await db
    .update(emailOutbox)
    .set({ status: "sent", sentAt: now })
    .where(eq(emailOutbox.id, row.id));
  return { kind: "sent" };
}

/** The REPO_TASKS body guard (the purge dispatch's typed-arm shape). */
export function isMailOutboxMessage(body: unknown): body is MailOutboxMessage {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { kind?: unknown; mailId?: unknown };
  return (
    candidate.kind === "mail-outbox" &&
    typeof candidate.mailId === "number" &&
    Number.isInteger(candidate.mailId) &&
    candidate.mailId > 0
  );
}

/**
 * The purge-arm adapter: process one message with the arm's ack/retry
 * policy — outcomes (noop/sent/failed) ack; only a transient (or a
 * could-not-persist) throw retries, exactly like every repo-tasks arm.
 */
export async function runMailOutboxArm(
  env: MailOutboxEnv,
  body: MailOutboxMessage,
  message: Message,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<void> {
  try {
    await processMailOutbox(env, body, options);
    message.ack();
  } catch (error) {
    console.error(
      `[repo-tasks] mail-outbox ${message.id} (mail ${body.mailId}) retrying:`,
      error instanceof Error ? error.message : String(error),
    );
    message.retry();
  }
}
