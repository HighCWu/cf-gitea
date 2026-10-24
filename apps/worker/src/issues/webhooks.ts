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

import type { DiffFileJson, DiffResult } from "@cf-gitea/git-engine";
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

// ---------------------------------------------------------------------------
// Push-payload commit file lists — §2.7 `PayloadCommit.added/removed/modified`
// (the mirror-wave deviation #2). Upstream fills them in ToAPIPayloadCommit
// (modules/repository/commits.go:72,91-93) through GetCommitFileStatus
// (modules/git/commit_file.go:69-88): `git log --name-status -m --first-parent
// --no-renames -z -1 <sha>` — i.e. ONE first-parent diff per commit (root
// commits diff against the empty tree; `-m --first-parent` reduces a merge to
// its first parent). Both the user-push path (services/repository/push.go:185-192
// → services/webhook/notifier.go:662) and the mirror-sync path
// (services/mirror/mirror_pull.go → notifier.go:903) funnel every payload
// commit through that same mapper, so the enrichment below is the single
// central step for both of ours.
// ---------------------------------------------------------------------------

/** The three per-commit file lists of upstream `api.PayloadCommit` (modules/structs/hook.go:170-175). */
export interface CommitFileLists {
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * The diff-read slice the enrichment needs. Satisfied by the repo cell's
 * `readDiff(id)` (packages/git-engine, repo.ts:760: one id = diff against the
 * commit's first parent, root commits against the empty tree) and by the API
 * layer's `EngineReads.readDiff` (src/api/services/engine.ts:116).
 */
export type CommitDiffRead = (id: string) => Promise<DiffResult | null>;

/**
 * File-type class of a tree-entry mode — the distinction git's --name-status
 * `T` (typechange) letter is built on: regular file (100644/100755), symlink
 * (120000), gitlink (160000). A mode change WITHIN a class is `M`; a change
 * across classes is `T`.
 */
function modeClass(mode: string): "file" | "symlink" | "gitlink" {
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  return "file";
}

/**
 * Port of upstream's classification (parseCommitFileStatus,
 * modules/git/commit_file.go:57-64, fed by GetCommitFileStatus :69-88 with
 * `--no-renames`): exactly the A/D/M letters map into the three lists and every
 * other letter is dropped. On the engine's structured DiffFileJson the letters
 * are:
 *   - `old === null` → `A` (added) — includes every file of a root commit,
 *     because readDiff diffs a root against the empty tree (repo.ts:769-771);
 *   - `new === null` → `D` (removed);
 *   - both sides present, same mode class → `M` (modified — content and
 *     exec-bit-only changes are both M upstream);
 *   - both sides present, class changed (file↔symlink) → upstream's `T`,
 *     which parseCommitFileStatus's switch has no case for (commit_file.go:57-64)
 *     and is therefore dropped from all three lists.
 * Renames: `--no-renames` disables rename detection upstream, so a rename is a
 * removed(old path) + added(new path) pair, never a modified — the engine's
 * computeDiff matches by path name with no rename detection either
 * (packages/git-engine/src/repo.ts:1216-1227), mirroring that exactly.
 *
 * DEVIATIONS (documented, engine-boundary level):
 *   - gitlink (submodule) paths never appear in readDiff output at all — the
 *     engine's flattenTree excludes mode 160000 entries (repo.ts:1205-1212) —
 *     while upstream's --name-status lists them as A/D/M.
 *   - List order is the engine's lexicographic diff order, not git's tree
 *     traversal order; per-status list contents are unaffected.
 *   - The engine caps a per-commit diff at MAX_DIFF_FILES=100 paths
 *     (repo.ts:94,1228, `truncated` flag); upstream lists every path.
 *
 * All three arrays are always present (possibly empty) — upstream initializes
 * them to empty (commit_file.go:23-27) and PayloadCommit always carries them
 * (commits.go:91-93).
 */
export function commitFileLists(files: readonly DiffFileJson[]): CommitFileLists {
  const lists: CommitFileLists = { added: [], removed: [], modified: [] };
  for (const file of files) {
    if (file.old === null && file.new !== null) {
      lists.added.push(file.path);
    } else if (file.old !== null && file.new === null) {
      lists.removed.push(file.path);
    } else if (file.old !== null && file.new !== null && modeClass(file.old.mode) === modeClass(file.new.mode)) {
      lists.modified.push(file.path);
    }
    // else: typechange (upstream `T`) — dropped, like upstream's switch.
  }
  return lists;
}

/**
 * Outcome of `enrichCommitsWithFileLists`: either every commit carries the
 * three lists, or the input array came back untouched (payload shape exactly
 * as before the wave — lists omitted).
 */
export type CommitFileListEnrichment<C> = { enriched: true; commits: Array<C & CommitFileLists> } | { enriched: false; commits: readonly C[] };

/**
 * Fill `added`/`removed`/`modified` on already-rendered payload commits
 * (anything with an `id`) before the payload is serialized — the step the
 * push/mirror renderers call between `toPayloadCommit` and
 * `emitWebhookDeliveries`. Cost discipline: exactly ONE readDiff per array
 * element, sequential, nothing else — the payload window is capped at
 * FEED_MAX_COMMIT_NUM=5 commits, so the ceiling is 5 diffs per event. The
 * array is order-preserving (upstream renders commits in rev-list order and
 * the lists ride along); the input objects are never mutated.
 *
 * Best-effort posture (the mirror-wave rule): a failed or unresolvable diff
 * read degrades to the CURRENT payload shape — the whole enrichment is
 * abandoned and the original array returns with the lists omitted — and this
 * function never throws, so a diff failure can never fail a delivery. Upstream
 * in contrast aborts the entire webhook when GetCommitFileStatus fails
 * (commits.go:72-74 → notifier.go:662-665); keeping the list-less delivery is
 * our documented deviation.
 */
export async function enrichCommitsWithFileLists<C extends { id: string }>(
  commits: readonly C[],
  readDiff: CommitDiffRead,
): Promise<CommitFileListEnrichment<C>> {
  const enriched: Array<C & CommitFileLists> = [];
  for (const commit of commits) {
    let diff: DiffResult | null;
    try {
      diff = await readDiff(commit.id);
    } catch {
      diff = null; // transport failure — same degradation as a null read
    }
    // A null diff (engine not-found or transport failure caught upstream)
    // abandons the enrichment: lists omitted beats lists half-filled.
    if (diff === null) {
      return { enriched: false, commits };
    }
    enriched.push({ ...commit, ...commitFileLists(diff.files) });
  }
  return { enriched: true, commits: enriched };
}
