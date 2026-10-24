/**
 * Webhook fan-out (§3.5) — the write-path side of the delivery pipeline.
 *
 * `emitWebhookDeliveries` runs AFTER the mutation's own transaction has
 * committed: route handlers call it inside `ctx.waitUntil(...)` so webhook
 * failure can never roll the mutation back (upstream likewise inserts hook
 * tasks after the fact). It resolves matching hooks (§3.5 step 1), formats
 * the payload once in the compat-frozen 2-space byte shape (§2.7), and batch
 * inserts one `webhook_deliveries` row per hook in `state='pending'`
 * (§3.5 step 3). Step 4 (Queue `{deliveryId}` messages) runs through the
 * optional `enqueue` callback until the `webhook-delivery` producer binding
 * is wired by the orchestrator.
 *
 * The delivery worker itself (§3.6 CAS, signatures, HTTP) is a separate
 * consumer; it only ever reads rows this module wrote.
 */

import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { webhookDeliveries, webhooks } from "../db/schema";

/** Event types (§2.6, gitea/modules/webhook/type.go:14–46; Actions-only ones deferred). */
export type HookEventType =
  | "create"
  | "delete"
  | "fork"
  | "push"
  | "issues"
  | "issue_assign"
  | "issue_label"
  | "issue_milestone"
  | "issue_comment"
  | "pull_request"
  | "pull_request_assign"
  | "pull_request_label"
  | "pull_request_milestone"
  | "pull_request_comment"
  | "pull_request_review_approved"
  | "pull_request_review_rejected"
  | "pull_request_review_comment"
  | "pull_request_sync"
  | "pull_request_review_request"
  | "wiki"
  | "repository"
  | "release"
  | "package"
  | "status";

/** Parsed `webhooks.events` JSON (upstream `HookEvent`, modules/webhook/events.go). */
export interface HookEventConfig {
  push_only?: boolean;
  send_everything?: boolean;
  choose_events?: boolean;
  branch_filter?: string;
  events?: Partial<Record<HookEventType | "pull_request_review", boolean>>;
}

/**
 * `X-Gitea-Event` group header value (upstream `HookEventType.Event()`): the
 * sub-events collapse into their group; the three review types keep upstream's
 * distinct group strings.
 */
const EVENT_GROUPS: Partial<Record<HookEventType, string>> = {
  issues: "issues",
  issue_assign: "issues",
  issue_label: "issues",
  issue_milestone: "issues",
  pull_request: "pull_request",
  pull_request_assign: "pull_request",
  pull_request_label: "pull_request",
  pull_request_milestone: "pull_request",
  pull_request_sync: "pull_request",
  pull_request_review_request: "pull_request",
  issue_comment: "issue_comment",
  pull_request_comment: "issue_comment",
  pull_request_review_approved: "pull_request_approved",
  pull_request_review_rejected: "pull_request_rejected",
  pull_request_review_comment: "pull_request_comment",
};

export function webhookEventGroup(eventType: HookEventType): string {
  return EVENT_GROUPS[eventType] ?? eventType;
}

/** The three review events share the `pull_request_review` subscription flag (§2.6). */
const REVIEW_GROUP_EVENTS: ReadonlySet<string> = new Set([
  "pull_request_review_approved",
  "pull_request_review_rejected",
  "pull_request_review_comment",
]);

/** Port of `Webhook.HasEvent` (models/webhook/webhook.go:171–185). */
export function webhookHasEvent(config: HookEventConfig, eventType: HookEventType): boolean {
  if (config.send_everything) return true;
  if (config.push_only) return eventType === "push";
  const check = REVIEW_GROUP_EVENTS.has(eventType) ? "pull_request_review" : eventType;
  return config.events?.[check] === true;
}

/**
 * Glob → RegExp with gobwas/glob semantics (upstream's matcher): `*` stays
 * within one path segment, `**` crosses separators, `?` is one non-separator
 * character. Character classes are not supported (no upstream branch filter
 * uses them).
 */
function compileGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Port of `checkBranchFilter` (services/webhook/webhook.go:110–130): empty/
 * `*`/`**` filters match everything; a payload without a ref is unaffected;
 * otherwise the filter matches the branch name or the full ref.
 * `refName` may be a branch name or a full ref.
 */
export function branchFilterAllows(branchFilter: string | undefined, refName: string | null | undefined): boolean {
  if (branchFilter === undefined || branchFilter === "" || branchFilter === "*" || branchFilter === "**") {
    return true;
  }
  if (refName === null || refName === undefined || refName === "") return true;
  const fullRef = refName.startsWith("refs/") ? refName : `refs/heads/${refName}`;
  const branchName = fullRef.startsWith("refs/heads/") ? fullRef.slice("refs/heads/".length) : null;
  const glob = compileGlob(branchFilter);
  if (branchName !== null && glob.test(branchName)) return true;
  return glob.test(fullRef);
}

export interface WebhookEmitInput {
  /** Repository the event happened on. */
  repoId: string;
  /** Owner (user/org) id for owner-level hooks; null = none resolvable. */
  ownerId?: number | null;
  eventType: HookEventType;
  /** JSON-serializable payload object (§2.7 shapes); serialized once. */
  payload: unknown;
  /** Branch name or full ref, for events the branch filter applies to. */
  refName?: string | null;
}

export interface WebhookEmitOptions {
  /**
   * §3.5 step 4 — enqueue `{deliveryId}` messages. Injected by callers once
   * the `webhook-delivery` Queue producer binding exists; absent, rows stay
   * `pending` and a later pass enqueues them.
   */
  enqueue?: (deliveryIds: number[]) => void | Promise<void>;
  now?: Date;
}

export interface WebhookEmitResult {
  /** Rows written (`state='pending'`); empty when no hook matched. */
  deliveryIds: number[];
}

/**
 * Fan one committed mutation out to its hooks (§3.5). Await nothing at the
 * call site: `ctx.waitUntil(emitWebhookDeliveries(db, input).then(undefined, onError))`.
 */
export async function emitWebhookDeliveries(
  d1: D1Database,
  input: WebhookEmitInput,
  options: WebhookEmitOptions = {},
): Promise<WebhookEmitResult> {
  const db = drizzle(d1);
  const hooks = await db
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.isActive, true),
        or(
          eq(webhooks.repoId, input.repoId),
          input.ownerId != null ? eq(webhooks.ownerId, input.ownerId) : undefined,
          eq(webhooks.isSystemWebhook, true),
        ),
      ),
    )
    .all();

  const matching = hooks.filter((hook) => {
    let config: HookEventConfig;
    try {
      config = JSON.parse(hook.events) as HookEventConfig;
    } catch {
      return false; // malformed subscription JSON never blocks the event
    }
    if (!webhookHasEvent(config, input.eventType)) return false;
    return branchFilterAllows(config.branch_filter, input.refName);
  });
  if (matching.length === 0) return { deliveryIds: [] };

  // §2.7: upstream stores `MarshalIndent(p, "", "  ")` — the exact bytes the
  // delivery worker signs and sends.
  const payloadContent = JSON.stringify(input.payload, null, 2);
  const now = options.now ?? new Date();
  const inserted = await db
    .insert(webhookDeliveries)
    .values(
      matching.map((hook) => ({
        hookId: hook.id,
        repoId: input.repoId,
        uuid: crypto.randomUUID(),
        eventType: input.eventType,
        eventGroup: webhookEventGroup(input.eventType),
        payloadContent,
        state: "pending" as const,
        createdAt: now,
      })),
    )
    .returning({ id: webhookDeliveries.id })
    .all();

  const deliveryIds = inserted.map((row) => row.id);
  if (options.enqueue !== undefined) {
    await options.enqueue(deliveryIds);
  }
  return { deliveryIds };
}
