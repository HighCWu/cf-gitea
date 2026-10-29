/**
 * Repo-tasks dead-letter queue consumer (SPEC-0014 §3.0 — the blocking M0
 * prerequisite, landed BEFORE the demo sweep rides the delete queue).
 *
 * Why: `repo-tasks` had no `dead_letter_queue` — after `max_retries: 5` the
 * message was DROPPED with only a per-attempt observability trace. The
 * 2026-10-28 e2e sweep hit this empirically (docs/reviews/
 * e2e-sweep-2026-10-28.md): a RepoCell destroy hit SQLITE_LOCKED, the queue
 * purge retried 5x, was dropped, and the cell survived as an orphan serving
 * stale refs under a name whose D1 row was gone. A demo whose cleaner
 * silently leaks is worse than no cleaner.
 *
 * Contract (ported from `webhookDlqHandler`, src/webhooks/dlq.ts:121-148):
 * every dead-lettered message is logged with full redrive context under the
 * stable `[repo-tasks-dlq]` prefix — kind label + the raw body VERBATIM
 * (the storageKey/engineNames or the typed `kind`: everything a manual
 * redrive needs) + the queue message id and attempt count — then acked.
 * SPEC-0018 §3.1 adds the DURABLE record the log never was: the same facts
 * land as a `system_notice` row (services/notices.ts) in the handler's
 * forward path — the notices arm of the admin UI reads them. The insert is
 * BEST-EFFORT NEXT TO the log, never instead of the ack (§5.3): a failed
 * notice write degrades to the log-only behavior of today, and a notices
 * outage can never turn this consumer into a DLQ loop.
 *
 * The handler NEVER throws and NEVER retries: a DLQ consumer that throws
 * (or retries a poison message) only loops. Bodies are decoded defensively —
 * unknown/malformed/unserializable bodies are logged-and-acked the same way
 * as known ones (the webhook DLQ's poisoned-body posture, dlq.ts:130-134).
 *
 * Message families — the authoritative `handleRepoTasks` dispatch arms
 * (src/repos/purge.ts):
 *
 *   - {storageKey, engineNames}  — repo delete purge (SPEC-0003 §2.5.5;
 *     structurally a purge has NO `kind` field)
 *   - {kind: "import-chunk" | "import-abort" | "import-sweep", …} — import
 *     pipeline (SPEC-0003 §2.6)
 *   - {kind: "repo-fork", sourceRepoId, forkRepoId} — fork replication
 *   - {kind: "mirror-sync", repoId} — pull-mirror sync (SPEC-0009 §2.6)
 *   - {kind: "push-mirror-sync", repoId, pushMirrorId} — push-mirror
 *     outbound sync (specs/push-mirror-outbound.md §4)
 *   - {kind: "demo-sweep", repoId} — the demo cleaner's delete (SPEC-0014 §3.2)
 *   - {kind: "audit-retention"} — the audit retention prune (SPEC-0015 §4.3)
 *
 * The notice TYPE mapping (§3.1) mirrors upstream's repository-vs-task split
 * (notice.go:21-26 — repo-subsystem failures vs maintenance-task outcomes):
 * the repo-scoped families (purge/import/fork/mirror-sync/push-mirror-sync)
 * emit type 1; the instance-scoped riders (demo-sweep, audit-retention) and
 * unclassifiable bodies emit type 2.
 *
 * The "error digest" honesty note: a dead-lettered queue message carries NO
 * error text — the per-attempt errors live only in the retrying consumer's
 * log lines (purge.ts's catch arms), and the platform hands the DLQ consumer
 * the body + attempt count. The description's diagnostic slot therefore
 * carries the serialized body VERBATIM (the redrive payload itself), bounded
 * by the §5.2 clip — kind + identity + attempts + the body is everything
 * this handler can know, with no new parsing (§3.1).
 *
 * ORCHESTRATOR INTEGRATION (config + mount are orchestrator-owned; this
 * module ships the handler only):
 *
 * ```ts
 * // src/index.ts queue() — before the repo-tasks fallback:
 * if (batch.queue === "repo-tasks-dlq") {
 *   return repoTasksDlqHandler(batch, env, _ctx);
 * }
 * ```
 */

import { SYSTEM_NOTICE_TYPE_REPOSITORY, SYSTEM_NOTICE_TYPE_TASK } from "../db/schema";
import { isMirrorSyncMessage } from "../services/mirror/sync";
import { isPushMirrorSyncMessage } from "../services/mirror/push-sync";
import { isDemoSweepMessage } from "../services/demo-sweep";
import { isAuditRetentionMessage } from "../services/audit";
import { recordNotice } from "../services/notices";
import { isForkMessage } from "./fork-task";
import { isImportMessage } from "./imports/pipeline";
import { isRepoPurgeMessage } from "./purge";

/** Stable log prefix — the operator greps this to find every dead letter. */
const LOG_PREFIX = "[repo-tasks-dlq]";

/**
 * Family label for a dead-lettered body, mirroring the `handleRepoTasks`
 * dispatch arms (module header). "unknown" covers malformed/poisoned
 * bodies — they are logged-and-acked exactly like the known ones.
 */
function kindLabel(body: unknown): string {
  if (isForkMessage(body)) return "repo-fork";
  if (isImportMessage(body)) return body.kind;
  if (isMirrorSyncMessage(body)) return "mirror-sync";
  if (isPushMirrorSyncMessage(body)) return "push-mirror-sync";
  if (isDemoSweepMessage(body)) return "demo-sweep";
  if (isAuditRetentionMessage(body)) return "audit-retention";
  if (isRepoPurgeMessage(body)) return "repo-purge";
  return "unknown";
}

/**
 * The notice type for a dead letter (§3.1): repo-scoped families are type 1
 * (upstream NoticeRepository — the repo-subsystem failure class), everything
 * else (the instance-scoped riders, and unclassifiable/poisoned bodies that
 * cannot claim a repo) is type 2 (upstream NoticeTask).
 */
function noticeTypeForLabel(label: string): 1 | 2 {
  switch (label) {
    case "repo-purge":
    case "import-chunk":
    case "import-abort":
    case "import-sweep":
    case "repo-fork":
    case "mirror-sync":
    case "push-mirror-sync":
      return SYSTEM_NOTICE_TYPE_REPOSITORY;
    default:
      return SYSTEM_NOTICE_TYPE_TASK;
  }
}

/**
 * The repo identity a decoded body carries, for the notice description.
 * Null for the identity-less arms (audit-retention, unknown) — their
 * descriptions drop the "for <identity>" clause. Reads only fields the
 * family guards already matched; a hostile getter throws into the caller's
 * classify arm (the never-throw contract catches it there).
 */
function repoIdentityOf(label: string, body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  switch (label) {
    case "repo-purge":
      return typeof record.storageKey === "string" ? record.storageKey : null;
    case "repo-fork":
      // The fork is the repo whose replication failed.
      return typeof record.forkRepoId === "string" ? record.forkRepoId : null;
    case "import-chunk":
    case "import-abort":
    case "import-sweep":
    case "mirror-sync":
    case "push-mirror-sync":
    case "demo-sweep":
      return typeof record.repoId === "string" ? record.repoId : null;
    default:
      return null; // audit-retention / unknown — no repo identity
  }
}

/**
 * A JSON-string body is only decoded for the kind label; malformed JSON
 * keeps the label "unknown" and the body is still logged verbatim below.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Raw body, verbatim, for the redrive log AND the notice's diagnostic slot
 * (the header's digest note). JSON-stringify is guarded: cyclic structures
 * and throwing getters make it throw, and this module must never — the
 * fallback line still tells the operator a body existed.
 */
function serializeBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    const json = JSON.stringify(body);
    return json === undefined ? "undefined" : json;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return `<unserializable: ${reason}>`;
  }
}

/** One dead letter's decoded record — the log line's and the notice's shared
 *  input, built defensively so no body shape can throw past the classifier. */
interface DeadLetterRecord {
  label: string;
  /** serializeBody output (verbatim or the guarded marker). */
  bodyText: string;
  /** The repo identity for the description; null on the identity-less arms. */
  identity: string | null;
}

function classifyDeadLetter(message: Message<unknown>): DeadLetterRecord {
  const body = message.body;
  const decoded = typeof body === "string" ? tryParseJson(body) : body;
  const label = kindLabel(decoded);
  return { label, bodyText: serializeBody(body), identity: repoIdentityOf(label, decoded) };
}

/**
 * The §3.1 description, rendered at emit (the DB never stores a template):
 * "<kind label> for <repo identity> dead-lettered after <attempts> attempts:
 * <diagnostic>" — the "for" clause drops on the identity-less arms. The
 * services/notices clip bounds the whole line at 2000 chars (§5.2).
 */
function deadLetterDescription(record: DeadLetterRecord, attempts: number): string {
  const subject = record.identity === null ? record.label : `${record.label} for ${record.identity}`;
  return `${subject} dead-lettered after ${attempts} attempts: ${record.bodyText}`;
}

/**
 * The best-effort notice write (§5.3): the caller wraps this in its
 * log-and-continue arm — a missing binding or a rejected insert throws HERE
 * and degrades to the log-only record, never past the ack path.
 */
async function emitDeadLetterNotice(env: Env, record: DeadLetterRecord, attempts: number): Promise<void> {
  const db = env.DB;
  if (db === undefined) {
    throw new Error("DB not bound (wrangler.jsonc); the DLQ notice emit degraded to log-only");
  }
  await recordNotice(db, {
    type: noticeTypeForLabel(record.label),
    description: deadLetterDescription(record, attempts),
  });
}

/**
 * The `repo-tasks-dlq` Queue consumer. Wire as a `queue()` dispatch arm in
 * src/index.ts (module header). Per message: the redrive log line, then the
 * SPEC-0018 §3.1 notice write (best-effort — ANY failure degrades to a
 * log-only line and control falls through), then the ack. A record failure
 * (a hostile body shape defeated the guards) still leaves an id-bearing
 * fallback line. Async for the awaited insert; nothing can reject past the
 * catches — the returned promise always resolves, so the platform's
 * invocation settles clean.
 */
export async function repoTasksDlqHandler(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx?: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    let record: DeadLetterRecord;
    try {
      record = classifyDeadLetter(message);
    } catch (error) {
      // The record itself failed (a hostile body shape defeated the guards)
      // — the id-only fallback keeps the dead letter visible, and control
      // falls through to the ack below: this consumer NEVER throws.
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`${LOG_PREFIX} id=${message.id} attempts=${message.attempts} kind=unknown body=<record failed: ${reason}>`);
      message.ack();
      continue;
    }
    console.error(`${LOG_PREFIX} id=${message.id} attempts=${message.attempts} kind=${record.label} body=${record.bodyText}`);
    // The SPEC-0018 §3.1 emit — best-effort NEXT TO the log (§5.3): on ANY
    // failure (unbound DB, rejected insert, hostile shape past the guards)
    // the degrade line keeps the fact visible and the ack path is untouched.
    try {
      await emitDeadLetterNotice(env, record, message.attempts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`${LOG_PREFIX} id=${message.id} attempts=${message.attempts} notice emit degraded to log-only: ${reason}`);
    }
    message.ack();
  }
}
