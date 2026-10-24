import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { HookEventConfig, HookEventType } from "../../issues/webhooks";
import { webhookEventGroup } from "../../issues/webhooks";
import { webhookDeliveries, webhooks } from "../../db/schema";
import { ApiError } from "../errors";
import {
  HOOK_TYPES,
  type CreateHookOption,
  type EditHookOption,
  type HookDelivery,
  type HookDeliveryRequest,
  type HookDeliveryResponse,
  type Hook,
} from "../models/webhook";
import type { RepositoryWithOwner } from "./repository";

/**
 * Webhook CRUD + delivery-log reads backing the tier-1 `repository` hook
 * routes (SPEC-0004 §2.4 rows repoListHooks / repoCreateHook / repoGetHook /
 * repoEditHook / repoDeleteHook / repoTestHook / repoListHookDeliveries;
 * behavior owned by SPEC-0005 §2.6/§3.5–3.6). Reads/writes the landed
 * `webhooks` + `webhook_deliveries` D1 tables (SPEC-0005 §3.2) through
 * Drizzle; nothing here talks to the delivery Queue — rows are written
 * `state='pending'` and the consumer (src/webhooks/consumer.ts) owns the
 * outbound HTTP.
 *
 * Upstream citations (submodule pin fc4936884584):
 *   - validation + create/edit ports: `routers/api/v1/utils/hook.go`
 *     (checkCreateHookOption / addHook / editHook);
 *   - response converter: `services/webhook/general.go ToHook`;
 *   - delivery converter: `services/webhook/general.go ToHookDelivery`
 *     (list variant blanks request/response payloads, `routers/api/v1/repo/hook.go ListDeliveries`);
 *   - test-fire: `services/webhook/webhook.go PrepareTestWebhook` — always
 *     creates the task, bypassing event subscriptions and branch filters.
 */

// ---------------------------------------------------------------------------
// Upstream validators (routers/api/v1/utils/hook.go + modules/validation)
// ---------------------------------------------------------------------------

/** `IsValidHookTaskType` (services/webhook/webhook.go:37) — the same set the
 *  vendored `CreateHookOption.type` enum declares; the zod schema gates the
 *  declaration, this gates the message. */
export function isValidHookTaskType(type: string): boolean {
  return (HOOK_TYPES as readonly string[]).includes(type);
}

/** `IsValidHookContentType` (models/webhook/webhook.go:117): json | form. */
export function isValidHookContentType(name: string): boolean {
  return name === "json" || name === "form";
}

/** `ToHookContentType` (models/webhook/webhook.go:81): json=1, form=2, else 0. */
export function toHookContentTypeId(name: string): number {
  return name === "json" ? 1 : name === "form" ? 2 : 0;
}

/** `HookContentType.Name()` (models/webhook/webhook.go). */
export function hookContentTypeName(id: number): string {
  return id === 1 ? "json" : id === 2 ? "form" : "";
}

/**
 * `IsValidURL` (modules/validation/helpers.go:42): ParseRequestURI + scheme
 * http/https + valid port. The WHATWG URL parser accepts a near-identical
 * grammar for absolute URLs (it additionally allows non-special schemes and
 * rejects nothing ParseRequestURI would keep for http(s)); the checked
 * invariants — absolute, http(s), numeric port ≤ 65535 — are the same.
 */
export function isValidWebhookUrl(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const port = parsed.port;
  if (port !== "" && !/^\d+$/.test(port)) return false;
  return port === "" || Number.parseInt(port, 10) <= 65535;
}

/** `IsValidSlackChannel` (services/webhook/slack.go:347): deliberately lax. */
export function isValidSlackChannel(name: string): boolean {
  return name !== "";
}

// ---------------------------------------------------------------------------
// Subscription events — ports of updateHookEvents / EventsArray
// (routers/api/v1/utils/hook.go + models/webhook/webhook.go:187)
// ---------------------------------------------------------------------------

/** Canonical row of the `webhooks` table (src/db/schema.ts). */
export type WebhookRow = typeof webhooks.$inferSelect;

/** `util.SliceContainsString(events, name, true)` — case-insensitive. */
function hasEvent(events: string[], name: string): boolean {
  return events.some((candidate) => candidate.toLowerCase() === name);
}

function issuesHook(events: string[], event: HookEventType): boolean {
  return hasEvent(events, event) || hasEvent(events, "issues");
}

function pullHook(events: string[], event: string): boolean {
  return hasEvent(events, event) || hasEvent(events, "pull_request");
}

/**
 * `updateHookEvents` (routers/api/v1/utils/hook.go): builds the HookEvents
 * subscription flags from the API-level event list. An EMPTY list defaults to
 * `["push"]`. The `*_only` pseudo-names and the shared `issues`/`pull_request`
 * group names behave exactly as upstream (subscribing to `issues` turns on
 * every issue sub-event). The two Actions-only events (`workflow_run`,
 * `workflow_job`) are deferred with the Actions surface (SPEC-0004 §2.5).
 */
export function updateHookEvents(events: string[]): NonNullable<HookEventConfig["events"]> {
  if (events.length === 0) {
    events = ["push"];
  }
  return {
    create: hasEvent(events, "create"),
    push: hasEvent(events, "push"),
    delete: hasEvent(events, "delete"),
    fork: hasEvent(events, "fork"),
    repository: hasEvent(events, "repository"),
    wiki: hasEvent(events, "wiki"),
    release: hasEvent(events, "release"),
    package: hasEvent(events, "package"),
    status: hasEvent(events, "status"),
    // Issues family: `issues_only` or the group name `issues`.
    issues: issuesHook(events, "issues"),
    issue_assign: issuesHook(events, "issue_assign"),
    issue_label: issuesHook(events, "issue_label"),
    issue_milestone: issuesHook(events, "issue_milestone"),
    issue_comment: issuesHook(events, "issue_comment"),
    // Pull request family: `pull_request_only` or the group name.
    pull_request: pullHook(events, "pull_request_only"),
    pull_request_assign: pullHook(events, "pull_request_assign"),
    pull_request_label: pullHook(events, "pull_request_label"),
    pull_request_milestone: pullHook(events, "pull_request_milestone"),
    pull_request_comment: pullHook(events, "pull_request_comment"),
    // The three review events share the `pull_request_review` subscription
    // flag (SPEC-0005 §2.6); the API level subscribes via the group name.
    pull_request_review: pullHook(events, "pull_request_review"),
    pull_request_review_request: pullHook(events, "pull_request_review_request"),
    pull_request_sync: pullHook(events, "pull_request_sync"),
  };
}

/** `AllEvents()` (modules/webhook/type.go:45) minus the Actions-only pair,
 *  in the same order — the `send_everything` EventsArray body. */
const ALL_EVENTS: readonly string[] = [
  "create",
  "delete",
  "fork",
  "push",
  "issues",
  "issue_assign",
  "issue_label",
  "issue_milestone",
  "issue_comment",
  "pull_request",
  "pull_request_assign",
  "pull_request_label",
  "pull_request_milestone",
  "pull_request_comment",
  "pull_request_review_approved",
  "pull_request_review_rejected",
  "pull_request_review_comment",
  "pull_request_sync",
  "pull_request_review_request",
  "wiki",
  "repository",
  "release",
  "package",
  "status",
];

/** Insertion order of `updateHookEvents`' map — the choose-events EventsArray
 *  body (Go map iteration order is random upstream; ours is deterministic). */
const SUBSCRIPTION_ORDER: readonly (keyof NonNullable<HookEventConfig["events"]>)[] = [
  "create",
  "push",
  "delete",
  "fork",
  "repository",
  "wiki",
  "release",
  "package",
  "status",
  "issues",
  "issue_assign",
  "issue_label",
  "issue_milestone",
  "issue_comment",
  "pull_request",
  "pull_request_assign",
  "pull_request_label",
  "pull_request_milestone",
  "pull_request_comment",
  "pull_request_review",
  "pull_request_review_request",
  "pull_request_sync",
];

/**
 * `Webhook.EventsArray` (models/webhook/webhook.go:187): send_everything →
 * every event; push_only → `["push"]`; otherwise the enabled subscription
 * flags. Parsed from the stored HookEvent JSON; a malformed blob degrades to
 * an empty list (the fan-out in src/issues/webhooks.ts likewise never trusts
 * malformed subscription JSON).
 */
export function hookEventsArray(eventsJson: string): string[] {
  let config: HookEventConfig;
  try {
    config = JSON.parse(eventsJson) as HookEventConfig;
  } catch {
    return [];
  }
  if (config.send_everything) return [...ALL_EVENTS];
  if (config.push_only) return ["push"];
  return SUBSCRIPTION_ORDER.filter((event) => config.events?.[event] === true);
}

// ---------------------------------------------------------------------------
// Response converters
// ---------------------------------------------------------------------------

/** SlackMeta JSON stored in `webhooks.meta` (webhook_service.SlackMeta). */
interface SlackMeta {
  channel?: string;
  username?: string;
  icon_url?: string;
  color?: string;
}

/**
 * `ToHook` (services/webhook/general.go:436) reduced to our columns: config
 * carries `{url, content_type}` (+ the Slack block from `meta`); the stored
 * authorization header is a secret and NEVER returned — the field renders as
 * the empty string exactly like upstream. The upstream-`json:"-"` settings
 * page URL (Hook.URL) is not serialized.
 */
export function toApiHook(row: WebhookRow): Hook {
  const config: Record<string, string> = {
    url: row.url,
    content_type: hookContentTypeName(row.contentType),
  };
  if (row.type === "slack") {
    let meta: SlackMeta = {};
    try {
      meta = JSON.parse(row.meta) as SlackMeta;
    } catch {
      // malformed meta renders the empty-string fields, like Go zero values
    }
    config.channel = meta.channel ?? "";
    config.username = meta.username ?? "";
    config.icon_url = meta.icon_url ?? "";
    config.color = meta.color ?? "";
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    branch_filter: branchFilterOf(row),
    config,
    events: hookEventsArray(row.events),
    authorization_header: "",
    active: row.isActive,
    updated_at: (row.updatedAt ?? row.createdAt ?? new Date(0)).toISOString(),
    created_at: (row.createdAt ?? new Date(0)).toISOString(),
  };
}

/** The branch filter lives inside the HookEvent JSON (our storage layout). */
function branchFilterOf(row: WebhookRow): string {
  try {
    return (JSON.parse(row.events) as HookEventConfig).branch_filter ?? "";
  } catch {
    return "";
  }
}

/**
 * `ToHookDelivery` (services/webhook/general.go:466): pending/delivering
 * rows are undelivered; `skipped`/`failed` record a non-attempt (our state
 * machine's extra terminal marks — no upstream equivalent, both render
 * is_delivered=false). `request`/`response` parse the consumer's stored
 * upstream-JSON-shape blobs; `null` when absent (`list` blanks the payload
 * fields exactly like upstream's ListDeliveries).
 */
export function toApiDelivery(
  row: typeof webhookDeliveries.$inferSelect,
  options: { omitPayload?: boolean } = {},
): HookDelivery {
  const isDelivered = row.state === "delivered";
  let request: HookDeliveryRequest | undefined;
  let response: HookDeliveryResponse | undefined;
  if (row.requestContent !== null) {
    try {
      request = JSON.parse(row.requestContent) as HookDeliveryRequest;
      if (options.omitPayload) {
        request = { ...request, headers: undefined, body: undefined };
      }
    } catch {
      request = undefined;
    }
  }
  if (row.responseContent !== null) {
    try {
      response = JSON.parse(row.responseContent) as HookDeliveryResponse;
      if (options.omitPayload) {
        response = { ...response, headers: undefined, body: undefined };
      }
    } catch {
      response = undefined;
    }
  }
  return {
    uuid: row.uuid,
    event_type: row.eventType,
    is_delivered: isDelivered,
    is_succeeded: row.isSucceed,
    delivered_at: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
    request,
    response,
  };
}

// ---------------------------------------------------------------------------
// D1 reads/writes (Drizzle ORM only)
// ---------------------------------------------------------------------------

export interface ListPage<T> {
  items: T[];
  total: number;
}

function clampPage(page: number, limit: number): { limit: number; offset: number } {
  return { limit, offset: (Math.max(1, page) - 1) * limit };
}

/** `ListWebhookOptions{RepoID}` + `db.FindAndCount` — id ASC (find default). */
export async function listRepoHooks(
  d1: D1Database,
  repoId: string,
  opts: { page: number; limit: number },
): Promise<ListPage<WebhookRow>> {
  const db = drizzle(d1);
  const { limit, offset } = clampPage(opts.page, opts.limit);
  const items = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.repoId, repoId))
    .orderBy(webhooks.id)
    .limit(limit)
    .offset(offset)
    .all();
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(webhooks)
    .where(eq(webhooks.repoId, repoId));
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/** `GetWebhookByRepoID` — repo-scoped id lookup, null when missing. */
export async function getRepoHook(d1: D1Database, repoId: string, hookId: number): Promise<WebhookRow | null> {
  const row = await drizzle(d1)
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.repoId, repoId), eq(webhooks.id, hookId)))
    .get();
  return row ?? null;
}

/**
 * `addHook` (routers/api/v1/utils/hook.go) — the checkCreateHookOption
 * validation runs in upstream's exact order with upstream's exact messages:
 *  1. `IsValidHookTaskType` → 422 "Invalid hook type: X" (the declared zod
 *     enum rejects foreign values at bind time — the 400-vs-422 divergence is
 *     the same class as the markdown route's malformed-JSON 400);
 *  2. config key `url` → 422 "Missing config option: url";
 *  3. config key `content_type` → 422 "Missing config option: content_type";
 *  4. `IsValidHookContentType` → 422 "Invalid content type";
 *  5. `IsValidURL` → 422 "Invalid url";
 * then the addHook body: `is_system_webhook` parse (422), Slack `channel`
 * requirement (422 missing / 400 invalid), HTTP method fixed POST,
 * `active` default FALSE (SPEC-0004 §2.4), events default ["push"],
 * branch_filter glob accepted and stored.
 */
export async function createRepoHook(d1: D1Database, repoId: string, form: CreateHookOption): Promise<WebhookRow> {
  if (!isValidHookTaskType(form.type)) {
    throw new ApiError(422, `Invalid hook type: ${form.type}`);
  }
  for (const name of ["url", "content_type"]) {
    if (form.config[name] === undefined) {
      throw new ApiError(422, `Missing config option: ${name}`);
    }
  }
  if (!isValidHookContentType(form.config.content_type ?? "")) {
    throw new ApiError(422, "Invalid content type");
  }
  if (!isValidWebhookUrl(form.config.url ?? "")) {
    throw new ApiError(422, "Invalid url");
  }

  let isSystemWebhook = false;
  if (form.config.is_system_webhook !== undefined && form.config.is_system_webhook !== "") {
    const parsed = form.config.is_system_webhook.toLowerCase();
    if (parsed !== "true" && parsed !== "1" && parsed !== "t" && parsed !== "false" && parsed !== "0" && parsed !== "f") {
      throw new ApiError(422, "Invalid is_system_webhook value");
    }
    isSystemWebhook = ["true", "1", "t"].includes(parsed);
  }

  const type = form.type;
  let meta = "";
  if (type === "slack") {
    const channel = (form.config.channel ?? "").trim();
    if (form.config.channel === undefined) {
      throw new ApiError(422, "Missing config option: channel");
    }
    if (!isValidSlackChannel(channel)) {
      throw new ApiError(400, "Invalid slack channel name");
    }
    meta = JSON.stringify({
      channel,
      username: form.config.username ?? "",
      icon_url: form.config.icon_url ?? "",
      color: form.config.color ?? "",
    } satisfies SlackMeta);
  }

  const eventsJson = JSON.stringify({
    choose_events: true,
    branch_filter: form.branch_filter ?? "",
    events: updateHookEvents(form.events ?? []),
  } satisfies HookEventConfig);

  const now = new Date();
  const result = await drizzle(d1)
    .insert(webhooks)
    .values({
      repoId,
      name: (form.name ?? "").trim(),
      url: form.config.url ?? "",
      contentType: toHookContentTypeId(form.config.content_type ?? ""),
      secret: form.config.secret ?? "",
      httpMethod: "POST",
      isSystemWebhook,
      events: eventsJson,
      isActive: form.active ?? false,
      type,
      meta,
      // Upstream encrypts with the instance SecretKey (SetHeaderAuthorization);
      // the at-rest encryption service lands with the settings module — the
      // column is read verbatim by the delivery consumer meanwhile.
      headerAuthorizationEncrypted: form.authorization_header ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all();
  const row = result[0];
  if (row === undefined) throw new Error("webhook insert lost");
  return row;
}

/**
 * `editHook` (routers/api/v1/utils/hook.go) — upstream quirks kept verbatim:
 * config `url`/`content_type` validate only when the key is present;
 * `events` and `branch_filter` are applied UNCONDITIONALLY (a PATCH without
 * them resets the subscription to push-only and clears the filter — the
 * upstream `w.HookEvents = updateHookEvents(form.Events)` line with nil
 * form.Events); `active`/`name` apply only when provided.
 */
export async function editRepoHook(
  d1: D1Database,
  row: WebhookRow,
  form: EditHookOption,
): Promise<WebhookRow> {
  const patch: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date() };

  if (form.config !== undefined) {
    if (form.config.url !== undefined) {
      if (!isValidWebhookUrl(form.config.url)) {
        throw new ApiError(422, "Invalid url");
      }
      patch.url = form.config.url;
    }
    if (form.config.content_type !== undefined) {
      if (!isValidHookContentType(form.config.content_type)) {
        throw new ApiError(422, "Invalid content type");
      }
      patch.contentType = toHookContentTypeId(form.config.content_type);
    }
    if (row.type === "slack" && form.config.channel !== undefined) {
      patch.meta = JSON.stringify({
        channel: form.config.channel,
        username: form.config.username ?? "",
        icon_url: form.config.icon_url ?? "",
        color: form.config.color ?? "",
      } satisfies SlackMeta);
    }
  }

  // Subscription rewrite is unconditional upstream: choose-events mode with
  // the rebuilt flag set (empty form.Events ⇒ push-only).
  patch.events = JSON.stringify({
    choose_events: true,
    branch_filter: form.branch_filter ?? "",
    events: updateHookEvents(form.events ?? []),
  } satisfies HookEventConfig);

  if (form.authorization_header !== undefined) {
    patch.headerAuthorizationEncrypted = form.authorization_header === "" ? null : form.authorization_header;
  }
  if (form.active !== undefined) {
    patch.isActive = form.active;
  }
  if (form.name !== undefined) {
    patch.name = form.name.trim();
  }

  const updated = await drizzle(d1)
    .update(webhooks)
    .set(patch)
    .where(eq(webhooks.id, row.id))
    .returning()
    .all();
  const next = updated[0];
  if (next === undefined) throw new Error("webhook update lost");
  return next;
}

/** `DeleteWebhookByRepoID` — true when a row was deleted. */
export async function deleteRepoHook(d1: D1Database, repoId: string, hookId: number): Promise<boolean> {
  const result = await drizzle(d1)
    .delete(webhooks)
    .where(and(eq(webhooks.repoId, repoId), eq(webhooks.id, hookId)))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** `ListHookTaskOptions` + `ToOrders()` ("hook_task.id DESC"). */
export async function listHookDeliveries(
  d1: D1Database,
  hookId: number,
  opts: { page: number; limit: number },
): Promise<ListPage<typeof webhookDeliveries.$inferSelect>> {
  const db = drizzle(d1);
  const { limit, offset } = clampPage(opts.page, opts.limit);
  const where = eq(webhookDeliveries.hookId, hookId);
  const items = await db
    .select()
    .from(webhookDeliveries)
    .where(where)
    .orderBy(desc(webhookDeliveries.id))
    .limit(limit)
    .offset(offset)
    .all();
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(webhookDeliveries).where(where);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

// ---------------------------------------------------------------------------
// Test-fire (POST …/hooks/{id}/tests)
// ---------------------------------------------------------------------------

/** Go's zero OID — the placeholder commit id while payload enrichment waits
 *  on the engine reads (see buildTestPushPayload). */
export const ZERO_OID = "0000000000000000000000000000000000000000";

/** The PushPayload field set (SPEC-0005 §2.7, modules/structs/hook.go:154). */
export interface TestPushPayload {
  ref: string;
  before: string;
  after: string;
  compare_url: string;
  commits: unknown[];
  total_commits: number;
  head_commit: unknown;
  repository: unknown;
  pusher: unknown;
  sender: unknown;
}

/** `Repository.ComposeCompareURL` (models/repo/repo.go:564) against the
 *  instance origin: `{owner}/{repo}/compare/{base}...{head}`. */
export function compareUrl(pair: RepositoryWithOwner, base: string, head: string): string {
  return `${pair.repo.ownerNamespace}/${pair.repo.slug}/compare/${base}...${head}`;
}

/**
 * The representative `PushPayload` of upstream `TestHook`
 * (routers/api/v1/repo/hook.go): `ref` is `refs/heads/<default branch>` or
 * the `ref` query param; before/after/head_commit carry the resolved tip
 * commit. DEVIATION: the API layer has no engine ref read yet (this batch is
 * D1-only), so the commit id is the zero OID and `commits`/`head_commit`
 * carry the empty placeholder instead of the `ToPayloadCommit` enrichment;
 * `repository`/`pusher`/`sender` are the route's converted API objects (same
 * serializers as the REST responses, per SPEC-0005 §2.7). The event type,
 * field set, and the 2-space serialization are compat-frozen; the values
 * upgrade in place when the engine read lands.
 */
export function buildTestPushPayload(
  pair: RepositoryWithOwner,
  ref: string,
  filled: { repository: unknown; pusher: unknown; sender: unknown },
): TestPushPayload {
  return {
    ref,
    before: ZERO_OID,
    after: ZERO_OID,
    compare_url: compareUrl(pair, ZERO_OID, ZERO_OID),
    commits: [],
    total_commits: 0,
    head_commit: null,
    repository: filled.repository,
    pusher: filled.pusher,
    sender: filled.sender,
  };
}

/**
 * `PrepareTestWebhook` (services/webhook/webhook.go:132): ALWAYS creates and
 * enqueues the delivery for THIS hook — bypassing event subscriptions,
 * branch filters, and the `is_active` gate (a manual test must verify
 * delivery even when those gates would suppress a real event). That is why
 * this writes the `webhook_deliveries` row directly instead of going through
 * `emitWebhookDeliveries` (src/issues/webhooks.ts): that fan-out resolves
 * hooks by repo/owner ∪ system with `is_active=true` and applies
 * `HasEvent` + branch filter — precisely the gates the test-fire bypasses —
 * and cannot target a single hook id. The row conventions are shared: same
 * table, `state='pending'`, `webhookEventGroup`, 2-space payload bytes.
 *
 * Returns the delivery id; the ROUTE decides whether to await the optional
 * enqueue callback inline or hang it off `c.executionCtx.waitUntil(...)`.
 */
export async function fireTestDelivery(
  d1: D1Database,
  hook: WebhookRow,
  eventType: HookEventType,
  payload: TestPushPayload,
  options: {
    repoId: string;
    enqueue?: (deliveryIds: number[]) => void | Promise<void>;
    now?: Date;
  },
): Promise<number> {
  const payloadContent = JSON.stringify(payload, null, 2);
  const inserted = await drizzle(d1)
    .insert(webhookDeliveries)
    .values({
      hookId: hook.id,
      repoId: options.repoId,
      uuid: crypto.randomUUID(),
      eventType,
      eventGroup: webhookEventGroup(eventType),
      payloadContent,
      state: "pending",
      createdAt: options.now ?? new Date(),
    })
    .returning({ id: webhookDeliveries.id })
    .all();
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error("delivery insert lost");
  if (options.enqueue !== undefined) {
    await options.enqueue([id]);
  }
  return id;
}
