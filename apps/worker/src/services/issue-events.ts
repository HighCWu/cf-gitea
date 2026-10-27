/**
 * Issue-family webhook events (SPEC-0005 §3.5) — the SHARED emission seam for
 * every issue write path.
 *
 * Two callers fan the same family out, and they must never diverge again:
 *
 *   - the `/api/v1` routes (src/api/routes/issues.ts): issueCreateIssue
 *     (opened, then closed when `form.closed`), issueEditIssue (edited on a
 *     title/body change, closed/reopened on a state transition) and
 *     issueCreateComment (issue_comment / pull_request_comment created);
 *   - the UI session write path (src/ui/pages/new-issue.tsx
 *     `createIssueFromForm`, the wave-4 new-issue form): the issues "opened"
 *     event, which that path previously never emitted (the wave-4 divergence
 *     — API-created issues notified subscribers, web-created ones did not).
 *
 * The delivery mechanics here are the routes' former inline helpers, moved
 * verbatim (behavior pinned by src/api/issues.test.ts's emitted-event
 * assertions): the delivery-row insert is AWAITED inline after the mutation
 * committed (request-visible — the hooks.ts fireTestDelivery precedent,
 * upstream CreateHookTask is synchronous too), failures are caught and
 * logged, never propagated, and only the Queue producer ({deliveryId} batch)
 * hangs off the executionCtx-guarded waitUntil — real worker invocations
 * enqueue; in-process callers (tests via router.fetch) have no execution
 * context, skip the enqueue, and leave the rows `pending` (the durable source
 * of truth; the consumer's idempotent CAS makes a later enqueue a safe
 * replay).
 *
 * The module sits beside webhooks-push.ts for the same reason that wave gave
 * (its header, "the builder lives HERE rather than in src/issues/webhooks.ts
 * because it composes api/services converters"): the §2.7 payload identity
 * (repository/sender) renders through api/services/repository converters, and
 * api/services/hooks.ts already imports src/issues/webhooks.ts — putting api
 * imports under that module would close a cycle. src/issues/webhooks.ts
 * stays the low-level delivery-row writer (§3.5 mechanics over a bare
 * D1Database); this module is the issue-family payload + emission layer over
 * it.
 *
 * ACTIVITY-FEED HOOK (specs/activity-feeds.md): emitIssueEvent additionally
 * records the upstream `action` rows this family produces (create_issue,
 * close/reopen_issue, comment_issue/comment_pull,
 * approve/reject_pull_request) through the shared recordAction fan-out —
 * same caught-and-logged posture, awaited inline so tests and readers see
 * the rows when the response lands. The UI session path rides along (it
 * funnels through emitIssueEvent).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ActionType, recordAction, type ActionDraft } from "../api/services/activity-feeds";
import { toApiIssue } from "../api/services/issues";
import {
  apiUserFromRow,
  findRepositoryById,
  toApiRepository,
  type RepositoryWithOwner,
  type Viewer,
} from "../api/services/repository";
import { users } from "../db/schema";
import type { IssueRow } from "../issues/service";
import { emitWebhookDeliveries, type HookEventType } from "../issues/webhooks";
import type { Issue } from "../api/models/issue";
import type { WebhookDeliveryMessage } from "../webhooks/consumer";

/** Structural `ExecutionContext` (the hono getter's annotation and the
 *  generated global drifted — the routes' precedent): only waitUntil is
 *  consumed here. */
export interface IssueEventExecution {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The hono-shaped request source both write paths hand over — the API routes
 * (`Context<ApiEnv>`) and the UI router (`Context<{ Bindings: Env }>`) are
 * both structurally this. `executionCtx` is hono's GETTER: it is read lazily
 * inside `emitIssueEvent`'s guard, because reading it throws for in-process
 * callers (tests via router.fetch) that have no execution context.
 */
export interface IssueEventRequest {
  /** Worker bindings (D1 for the fan-out, the optional Queue producer). */
  readonly env: Env;
  /** `Context.executionCtx` — read inside the try/catch (see above). */
  readonly executionCtx: IssueEventExecution;
}

/** One issue-family webhook event: where, who owns the repo, what, and the
 *  §2.7 payload (already rendered — see issueEventPayload). */
export interface IssueEventEmission {
  /** Repository the event happened on. */
  repoId: string;
  /** Owner (user/org) id for owner-level hooks; null = none resolvable. */
  ownerId: number | null;
  eventType: HookEventType;
  payload: unknown;
}

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired. */
function webhookDeliveryQueue(env: Env): {
  sendBatch(messages: { body: WebhookDeliveryMessage }[]): Promise<unknown>;
} | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Activity-feed hook (specs/activity-feeds.md §3.2/§3.3): the issue-family
// actions upstream's actionNotifier writes (services/feed/notifier.go):
// NewIssue → create_issue with "index|title" (:41-63), IssueChangeStatus →
// close/reopen with "index|" (:66-97), CreateIssueComment → comment_issue /
// comment_pull with "index|excerpt" (:99-124), a submitted review →
// approve/reject_pull_request / comment_pull with "index|content"
// (:207-275). Everything else in the family (label/milestone/assign/
// review-request webhooks, comment edits/deletes) writes NO action upstream
// and none here; the PR-lifecycle events (open/close/reopen/merge) flow
// through routes/pulls.ts' LOCAL emitPullWebhook seam, outside this module —
// those matrix rows stay DEFERRED (SPEC §3.3).
// ---------------------------------------------------------------------------

/** Structural read of one rendered §2.7 payload field (payload is `unknown`). */
function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
}

function payloadNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function payloadString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The issue-family action draft for one emission, or null when the event
 * carries no upstream action. Issue-vs-PR discrimination follows the
 * payload's `issue.pull_request` meta (the API Issue renders it for PRs
 * only). Comment excerpts ship as the raw API body — upstream flattens
 * through markdown.FeedExcerpt, the documented SPEC divergence.
 */
export function issueActionDraft(emission: IssueEventEmission): ActionDraft | null {
  const payload = payloadRecord(emission.payload);
  if (payload === null) return null;
  const actUserId = payloadNumber(payloadRecord(payload.sender), "id");
  if (actUserId === undefined) return null;
  const isPrivate = payloadRecord(payload.repository)?.private === true;
  const issue = payloadRecord(payload.issue);
  const issueNumber = payloadNumber(issue, "number");

  switch (emission.eventType) {
    case "issues": {
      if (issueNumber === undefined) return null;
      const title = payloadString(issue, "title") ?? "";
      const isPull = payloadRecord(issue?.pull_request) !== null;
      switch (payload.action) {
        case "opened":
          return {
            actUserId,
            repoId: emission.repoId,
            opType: isPull ? ActionType.CreatePullRequest : ActionType.CreateIssue,
            isPrivate,
            content: `${issueNumber}|${title}`,
          };
        case "closed":
          return {
            actUserId,
            repoId: emission.repoId,
            opType: isPull ? ActionType.ClosePullRequest : ActionType.CloseIssue,
            isPrivate,
            content: `${issueNumber}|`,
          };
        case "reopened":
          return {
            actUserId,
            repoId: emission.repoId,
            opType: isPull ? ActionType.ReopenPullRequest : ActionType.ReopenIssue,
            isPrivate,
            content: `${issueNumber}|`,
          };
        default:
          return null;
      }
    }
    case "issue_comment":
    case "pull_request_comment": {
      // Upstream actions fire on comment CREATE only (no notifier for
      // edited/deleted).
      if (payload.action !== "created" || issueNumber === undefined) return null;
      const comment = payloadRecord(payload.comment);
      const commentId = payloadNumber(comment, "id");
      if (commentId === undefined) return null;
      return {
        actUserId,
        repoId: emission.repoId,
        opType: emission.eventType === "issue_comment" ? ActionType.CommentIssue : ActionType.CommentPull,
        isPrivate,
        content: `${issueNumber}|${payloadString(comment, "body") ?? ""}`,
        commentId,
      };
    }
    case "pull_request_review_approved":
    case "pull_request_review_rejected":
    case "pull_request_review_comment": {
      const number = payloadNumber(payload, "number");
      if (number === undefined) return null;
      const body = payloadString(payloadRecord(payload.review), "content") ?? "";
      // Upstream skips the comment-review action when the body is blank
      // (notifier.go:244-246); approve/reject always fire.
      if (emission.eventType === "pull_request_review_comment" && body.trim() === "") return null;
      const opType =
        emission.eventType === "pull_request_review_approved"
          ? ActionType.ApprovePullRequest
          : emission.eventType === "pull_request_review_rejected"
            ? ActionType.RejectPullRequest
            : ActionType.CommentPull;
      return { actUserId, repoId: emission.repoId, opType, isPrivate, content: `${number}|${body}` };
    }
    default:
      return null;
  }
}

/** Best-effort action-row write — caught, logged, never propagated (the
 *  webhook fan-out posture; a lost insert is a feed gap, not an API error).
 *  `now` is the wall-clock seam (render-wallclock-audit): the drafts carry
 *  no createdAt of their own, so without it recordAction stamps new Date()
 *  into the feed rows the profile-activity/user feeds render as TimeSince. */
async function recordIssueAction(env: Env, emission: IssueEventEmission, now?: Date): Promise<void> {
  const draft = issueActionDraft(emission);
  if (draft === null) return;
  try {
    await recordAction(env.DB, now === undefined ? draft : { ...draft, createdAt: now });
  } catch (error) {
    console.error(`[issues] action row failed (${emission.eventType}): ${errorMessage(error)}`);
  }
}

/**
 * Fire one issue-family webhook event. The delivery-row insert is AWAITED
 * inline (request-visible, the hooks.ts fireTestDelivery precedent — upstream
 * CreateHookTask is synchronous too) so tests and downstream observers see
 * the row when the response lands; failures are caught and logged, never
 * propagated into the response. Only the Queue producer ({deliveryId} batch)
 * hangs off the executionCtx-guarded waitUntil — real worker invocations
 * enqueue; in-process callers (tests via router.fetch) have no executionCtx,
 * skip the enqueue, and leave the rows `pending` (the durable source of
 * truth; the consumer's idempotent CAS makes a later enqueue a safe replay).
 */
export async function emitIssueEvent(
  request: IssueEventRequest,
  emission: IssueEventEmission,
  // Wall-clock seam (render-wallclock-audit): one clock for the whole
  // emission — the delivery rows' createdAt (emitWebhookDeliveries'
  // options.now) and the action draft's createdAt. Omitted → new Date(),
  // byte-identical to the previous behavior; every caller is unchanged.
  options?: { now?: Date },
): Promise<void> {
  let execCtx: IssueEventExecution | undefined;
  try {
    execCtx = request.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(request.env);
  try {
    await emitWebhookDeliveries(request.env.DB, { ...emission, refName: null }, {
      now: options?.now,
      enqueue:
        queue !== null && execCtx !== undefined
          ? (deliveryIds) => {
              execCtx.waitUntil(
                queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                  console.error(`[issues] delivery enqueue failed (${emission.eventType}): ${errorMessage(error)}`);
                }),
              );
            }
          : undefined,
    });
  } catch (error) {
    console.error(`[issues] webhook fan-out failed (${emission.eventType}): ${errorMessage(error)}`);
  }
  await recordIssueAction(request.env, emission, options?.now);
}

/**
 * The shared IssuePayload wrapper (§2.7, modules/structs/hook.go:435).
 */
export function issueEventPayload(
  action: string,
  apiIssue: Issue,
  index: number,
  repository: unknown,
  sender: unknown,
  options: { changes?: Record<string, { from: string }>; commitId?: string } = {},
): Record<string, unknown> {
  return {
    action,
    number: index,
    ...(options.changes === undefined ? {} : { changes: options.changes }),
    issue: apiIssue,
    repository,
    sender,
    commit_id: options.commitId ?? "",
  };
}

/** Issue-event bundle: the webhook `repository` object + doer sender + the
 *  owner id that resolves owner-level hooks (§3.5 step 1's repo ∪ owner ∪
 *  system union). */
export interface IssueEventIdentity {
  repository: unknown;
  sender: unknown;
  ownerId: number | null;
}

/** Assemble the bundle from a Viewer over a repo+owner pair — the identity
 *  half every issue payload embeds, rendered by the same §2.7 converters as
 *  the REST responses. */
export function issueEventIdentity(viewer: Viewer, pair: RepositoryWithOwner, sender: unknown): IssueEventIdentity {
  return {
    repository: toApiRepository(viewer, pair),
    sender,
    ownerId: pair.repo.ownerId,
  };
}

// ---------------------------------------------------------------------------
// The UI session write path (pages/new-issue.tsx — createIssueFromForm).
// ---------------------------------------------------------------------------

/** Inputs of the UI new-issue fan-out (emitSessionIssueOpened). */
export interface SessionIssueOpenedInput {
  /** The hono request source (the UI router's context, structurally). */
  request: IssueEventRequest;
  /** Instance origin the §2.7 payload URLs are built against (ctx.origin). */
  origin: string;
  /** The repository the issue was filed on. */
  repoId: string;
  /** The created issue row (IssuesService.createIssue's result). */
  issue: IssueRow;
  /** The session doer's user id — payload sender. */
  posterId: number;
}

/**
 * The UI new-issue write path's fan-out: the SAME `issues` "opened" event the
 * POST /repos/{owner}/{repo}/issues route emits (same payload builder, same
 * delivery mechanics through emitIssueEvent), assembled from what the session
 * path holds — the resolved repo row, the created issue, the session doer.
 *
 * The doer serializes through `apiUserFromRow` — the SAME converter that
 * renders the payload's embedded `repository.owner` (payload-internal
 * §2.7 consistency; the push-webhook sender precedent), self-rendered so the
 * doer sees their own email exactly like upstream's convert.ToUser(doer,
 * doer). The API route keeps its token-identity serialization (toApiUser) —
 * behavior-identical there, pinned by its own tests.
 *
 * Never throws: the identity assembly and the fan-out are best-effort (the
 * write already committed; a webhook failure must never fail it — the same
 * posture as the route, which renders its payload outside the try/catch but
 * whose create handler awaits an already-caught emit). Identity resolution
 * failures (orphaned repo row, missing doer row) log and skip, the push
 * wave's degradation rule.
 */
export async function emitSessionIssueOpened(input: SessionIssueOpenedInput): Promise<void> {
  try {
    const pair = await findRepositoryById(input.request.env.DB, input.repoId);
    if (pair === null) {
      console.error(`[issues] webhook fan-out skipped (opened): repository row missing [id: ${input.repoId}]`);
      return;
    }
    const poster =
      (await drizzle(input.request.env.DB).select().from(users).where(eq(users.id, input.posterId)).limit(1).all())[0] ?? null;
    if (poster === null) {
      console.error(`[issues] webhook fan-out skipped (opened): doer row missing [id: ${input.posterId}]`);
      return;
    }
    // Self-render bootstrap: apiUserFromRow reads only login/is_admin off the
    // viewer, so the first pass (anonymous viewer) yields the doer object the
    // second pass needs to authenticate the doer against themself.
    const viewer: Viewer = { origin: input.origin, requester: apiUserFromRow(poster, { origin: input.origin, requester: null }) };
    const identity = issueEventIdentity(viewer, pair, apiUserFromRow(poster, viewer));
    await emitIssueEvent(input.request, {
      repoId: pair.repo.id,
      ownerId: identity.ownerId,
      eventType: "issues",
      payload: issueEventPayload("opened", await toApiIssue(input.request.env.DB, viewer, pair, input.issue), input.issue.index, identity.repository, identity.sender),
    });
  } catch (error) {
    console.error(`[issues] webhook fan-out failed (opened): ${errorMessage(error)}`);
  }
}
