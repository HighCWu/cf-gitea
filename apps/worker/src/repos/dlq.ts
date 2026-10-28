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
 * Unlike the webhook DLQ there is NO D1 row to flip and no notices table:
 * the observability log IS the record, and drain = manual redrive (re-queue
 * the logged body to `repo-tasks` via wrangler queues redrive / a scripted
 * `send`; every consumer step is idempotent per SPEC-0003 §2.5.5, so
 * redelivery is safe by construction).
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

import { isMirrorSyncMessage } from "../services/mirror/sync";
import { isPushMirrorSyncMessage } from "../services/mirror/push-sync";
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
  if (isRepoPurgeMessage(body)) return "repo-purge";
  return "unknown";
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
 * Raw body, verbatim, for the redrive log. JSON-stringify is guarded:
 * cyclic structures and throwing getters make it throw, and this module
 * must never — the fallback line still tells the operator a body existed.
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

/** One dead letter's full record — the ONLY durable trace of the dropped
 *  work, so it carries everything a manual redrive needs on one line. */
function recordDeadLetter(message: Message<unknown>): void {
  const body = message.body;
  const decoded = typeof body === "string" ? tryParseJson(body) : body;
  const label = kindLabel(decoded);
  console.error(`${LOG_PREFIX} id=${message.id} attempts=${message.attempts} kind=${label} body=${serializeBody(body)}`);
}

/**
 * The `repo-tasks-dlq` Queue consumer. Wire as a `queue()` dispatch arm in
 * src/index.ts (module header). Every message is logged then acked — a
 * DLQ consumer that throws or retries only loops, so even a message whose
 * record fails gets an id-only fallback line and its ack. Synchronous on
 * purpose: pure log-and-ack, no awaits, so nothing can reject.
 */
export function repoTasksDlqHandler(
  batch: MessageBatch<unknown>,
  _env: Env,
  _ctx?: ExecutionContext,
): void {
  for (const message of batch.messages) {
    try {
      recordDeadLetter(message);
    } catch (error) {
      // The record itself failed (a hostile body shape defeated the guards)
      // — the id-only fallback keeps the dead letter visible, and control
      // falls through to the ack below: this consumer NEVER throws.
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`${LOG_PREFIX} id=${message.id} attempts=${message.attempts} kind=unknown body=<record failed: ${reason}>`);
    }
    message.ack();
  }
}
