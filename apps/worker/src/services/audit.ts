/**
 * The audit-event emit seam (SPEC-0015 §4.2/§4.3) — the action registry, the
 * message renderer, the typed emit helpers over the `audit_event` D1 table
 * (schema.ts, migration 0038), and the retention producer/consumer pair.
 *
 * ## The seam (§4.2)
 *
 * Two emit forms, one row shape:
 *
 *   - `auditEventInsert(db, event)` — returns the drizzle INSERT builder for
 *     the caller's `db.batch([...])`. This is the PREFERRED form: the audit
 *     row commits (or rolls back) atomically with the write it describes —
 *     "audit rows must not outlive the write they describe" without a
 *     compensating delete. The slice-one instrumentation (RepoService.create,
 *     OrgService.createOrg) rides this form.
 *   - `emitAudit(db, event)` — the standalone awaited insert for write paths
 *     that have no single-statement transaction around them. Awaiting is
 *     deliberate: a fire-and-forget promise violates the Workers rules
 *     (no untracked background work), and the row must be durably recorded
 *     before the response claims success.
 *
 * The `message` column stores the RENDERED text (upstream renders the
 * action's template at emit time too); the caller passes template `vars` and
 * the seam renders — the DB never stores a template.
 *
 * ## The registry
 *
 * `defineAction(id, messageTemplate)` mirrors upstream's define() pattern
 * (gitea/models/audit/action.go:18-26): hierarchical colon-separated ids,
 * each with a message template, registered once at module load; duplicate
 * registration throws (upstream panics). Slice one registers the
 * `organization:*` and `repository:*` families verbatim (ids AND templates —
 * the templates are upstream's, stable parse targets per action.go's own
 * stability note); `user:*`/`system:*` classes exist in the type space
 * (ScopeType/Origin unions) and register with their own waves. One deliberate
 * id divergence, documented at its definition: `organization:member:add`
 * (upstream defines only member:remove — upstream's member additions always
 * flow through team-add, our org-level membership primitive needs the
 * symmetric id).
 *
 * ## Retention (§4.3)
 *
 * The demo-sweep shape (SPEC-0014 §3, services/demo-sweep.ts): a cron
 * producer SELECTs + enqueues ONLY; a queue consumer does the delete with its
 * own budget ("crons enqueue, consumers do the work", AGENTS.md Workers
 * rules). The window default is 90 days (ratification §7 item 4), carried by
 * the `AUDIT_RETENTION_DAYS` config var — the producer ARMS only when the var
 * holds a positive integer (fail-closed, the demoModeEnabled posture):
 * absent/invalid ⇒ zero reads, zero sends, zero log lines. The consumer
 * applies the same var (default 90 when absent) at consume time and prunes in
 * bounded pages; a throw retries the idempotent message.
 */

import { and, asc, desc, eq, gt, inArray, like, lt, or, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { auditEvents } from "../db/schema";

// ---------------------------------------------------------------------------
// Types — upstream ScopeType (scopes.go:11-16) and Origin (origin.go:9-14)
// ---------------------------------------------------------------------------

export type AuditScopeType = "system" | "user" | "organization" | "repository";
export type AuditOrigin = "ui" | "api" | "cli" | "system";

// ---------------------------------------------------------------------------
// The action registry — upstream define() (action.go:18-26)
// ---------------------------------------------------------------------------

const actionTemplates = new Map<string, string>();

/**
 * Register an audit action with its message template. Ids are hierarchical
 * colon ids; duplicate registration is a programming error and throws
 * (upstream panics, action.go:21-23). Returns the id for convenient const
 * definitions.
 */
export function defineAction(id: string, messageTemplate: string): string {
  if (actionTemplates.has(id)) {
    throw new Error("duplicate audit action: " + id);
  }
  actionTemplates.set(id, messageTemplate);
  return id;
}

/** The registered template for an action (upstream MessageTemplate). */
export function messageTemplate(action: string): string | undefined {
  return actionTemplates.get(action);
}

/**
 * Every registered action and its selectable hierarchy prefixes, sorted —
 * upstream ActionFilters (action.go:38-57). The prefix loop starts at TWO
 * segments on purpose (upstream i=2): the one-segment family root
 * (`repository`) is NOT itself a filter — an operator filters
 * `repository:visibility` or the exact `repository:create`, never the bare
 * family — so only actions of three or more segments derive prefixes.
 */
export function actionFilters(): string[] {
  const filters = new Set<string>();
  for (const action of actionTemplates.keys()) {
    filters.add(action);
    const parts = action.split(":");
    for (let i = 2; i < parts.length; i++) {
      filters.add(parts.slice(0, i).join(":"));
    }
  }
  return [...filters].sort();
}

/**
 * Render an action's message template by substituting `{token}` vars.
 * Registered-token-but-missing-var renders the bare token literally (NOT
 * upstream's Go `<no value>` — a visible `{member}` names the bug in the
 * page instead of printing a placeholder; divergence is cosmetic, the
 * templates themselves are verbatim).
 */
export function renderMessage(action: string, vars: Record<string, string> = {}): string {
  const template = actionTemplates.get(action);
  if (template === undefined) {
    throw new Error("unregistered audit action: " + action);
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (token: string, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : token;
  });
}

/**
 * The slice-one registry — the `organization:*` and `repository:*` families
 * verbatim from upstream action.go:114-171 (ids AND templates; the stability
 * note at action.go:200-201 applies to the system family, but the same
 * "parsers trace events across versions" discipline is why templates are
 * ported without rewording). Ordering follows upstream's blocks.
 */
export const AuditActions = {
  // organization:* (action.go:114-134)
  OrganizationCreate: defineAction("organization:create", "Created organization {scope}."),
  OrganizationDelete: defineAction("organization:delete", "Deleted organization {scope}."),
  OrganizationName: defineAction("organization:name:update", "Changed organization name from {previous_name} to {scope}."),
  OrganizationVisibility: defineAction("organization:visibility", "Changed visibility of organization {scope} to {new_visibility}."),
  // DIVERGENCE (the one in slice one): upstream defines member:remove only —
  // its member additions always flow through team-add
  // (organization:team:member:add). Our org-level membership primitive has no
  // team, so the symmetric id registers here for the downstream member wave;
  // the template mirrors member:remove's shape.
  OrganizationMemberAdd: defineAction("organization:member:add", "Added user {member} to organization {scope}."),
  OrganizationMemberRemove: defineAction("organization:member:remove", "Removed user {member} from organization {scope}."),
  OrganizationTeamAdd: defineAction("organization:team:add", "Added team {team} to organization {scope}."),
  OrganizationTeamUpdate: defineAction("organization:team:update", "Updated settings of team {scope}/{team}."),
  OrganizationTeamRemove: defineAction("organization:team:remove", "Removed team {team} from organization {scope}."),
  OrganizationTeamPermission: defineAction("organization:team:permission", "Changed permission of team {scope}/{team} to {permission}."),
  OrganizationTeamMemberAdd: defineAction("organization:team:member:add", "Added user {member} to team {scope}/{team}."),
  OrganizationTeamMemberRemove: defineAction("organization:team:member:remove", "Removed user {member} from team {scope}/{team}."),
  // repository:* (action.go:136-171)
  RepositoryCreate: defineAction("repository:create", "Created repository {scope}."),
  RepositoryCreateFork: defineAction("repository:fork:create", "Created fork {scope} of repository {base_repo}."),
  RepositoryArchive: defineAction("repository:archive", "Archived repository {scope}."),
  RepositoryUnarchive: defineAction("repository:unarchive", "Unarchived repository {scope}."),
  RepositoryDelete: defineAction("repository:delete", "Deleted repository {scope}."),
  RepositoryName: defineAction("repository:name:update", "Changed repository name from {previous_name} to {scope}."),
  RepositoryVisibility: defineAction("repository:visibility:update", "Changed visibility of repository {scope} to {visibility}."),
} as const;

// ---------------------------------------------------------------------------
// The emit seam (§4.2)
// ---------------------------------------------------------------------------

export interface AuditEventInput {
  /** A registered action id (defineAction). Unregistered ids throw — an
   *  unrenderable audit row is a programming error, not a runtime event. */
  action: string;
  actorId: number;
  /** Snapshot at emit time; '' when the caller has no resolved name. A
   *  drizzle `sql` expression is allowed for in-batch emits whose snapshot
   *  is only knowable mid-transaction (e.g. the org create's creator-name
   *  subquery); the seam passes it through to `.values()` untouched. */
  actorName?: string | SQL;
  /** "access-token:<id>" etc.; null when the write rode a session. */
  actorCredential?: string | null;
  /** Admin acting as the actor; 0/absent = no impersonation. */
  impersonatorId?: number;
  impersonatorName?: string | null;
  scopeType: AuditScopeType;
  /** The entity id WITHIN the scope type: repository scope takes the
   *  `repositories.id` UUID, user/organization scope takes the numeric
   *  `users.id` (normalized to its decimal string). `""` is system
   *  (upstream: "zero for system"). An `sql` expression is allowed for
   *  in-batch emits whose id is allocated by a statement of the same
   *  transaction (the org create's scalar subquery — cast to text there,
   *  per the schema's scope_id drift note). */
  scopeId: string | number | SQL;
  scopeName?: string | null;
  origin: AuditOrigin;
  /** Template vars for renderMessage — the message column stores the
   *  rendered text. Mutually exclusive with `message`. */
  vars?: Record<string, string>;
  /** Pre-rendered override (rare — telemetry bridges only). */
  message?: string;
  /** Target-specific details; JSON-encoded, null when empty. */
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  /** Emit time; default now. */
  timestamp?: Date;
}

/**
 * Build the audit_event INSERT for the caller's `db.batch([...])` — the
 * transactional form (§4.2: the audit row commits/rolls back WITH the write).
 * The statement must go into a batch built from the SAME drizzle instance.
 */
export function auditEventInsert(db: DrizzleD1Database, event: AuditEventInput) {
  const scopeId = typeof event.scopeId === "number" ? String(event.scopeId) : event.scopeId;
  const message =
    event.message ??
    renderMessage(event.action, event.vars ?? {});
  const metadata =
    event.metadata === undefined || event.metadata === null || Object.keys(event.metadata).length === 0
      ? null
      : JSON.stringify(event.metadata);
  return db.insert(auditEvents).values({
    action: event.action,
    actorId: event.actorId,
    actorName: event.actorName ?? "",
    actorCredential: event.actorCredential ?? null,
    impersonatorId: event.impersonatorId ?? 0,
    impersonatorName: event.impersonatorName ?? null,
    scopeType: event.scopeType,
    scopeId,
    scopeName: event.scopeName ?? null,
    origin: event.origin,
    message,
    metadata,
    ipAddress: event.ipAddress ?? null,
    createdUnix: event.timestamp ?? new Date(),
  });
}

/**
 * The standalone emit (§4.2's `emitAudit(db, event)`): render + insert,
 * awaited. Use the `auditEventInsert` batch form instead wherever the write
 * path has a D1 batch to ride — that form is what makes "a failed write emits
 * nothing" structural rather than compensating.
 */
export async function emitAudit(db: DrizzleD1Database, event: AuditEventInput): Promise<void> {
  await auditEventInsert(db, event);
}

// ---------------------------------------------------------------------------
// The paged read — upstream FindEvents/EventSearchOptions parity
// (audit_event.go:161-209), the read the settings audit tabs render from
// (downstream pages) and the query-per-shape the composite index serves.
// ---------------------------------------------------------------------------

export interface AuditEventRow {
  id: number;
  action: string;
  actorId: number;
  actorName: string;
  actorCredential: string | null;
  impersonatorId: number;
  impersonatorName: string | null;
  scopeType: AuditScopeType;
  scopeId: string;
  scopeName: string | null;
  origin: AuditOrigin;
  message: string;
  metadata: string | null;
  ipAddress: string | null;
  createdUnix: Date;
}

export type AuditEventSort = "timestamp_asc" | "timestamp_desc";

export interface AuditEventQuery {
  /** Exact action filter (upstream `Action`). Mutually exclusive with
   *  `actionPrefix` (upstream's ToConds if/else — exact wins). */
  action?: string;
  /** Family-prefix filter (upstream `ActionPrefix`): `action LIKE 'prefix:%'`
   *  — the idx_audit_event_action index range serves it. */
  actionPrefix?: string;
  /** The actor's trail — an impersonated event belongs to BOTH the actor and
   *  the admin behind it (upstream ToConds' OR, audit_event.go:182-184). */
  actorId?: number;
  /** Applied independently so a missing scope ID narrows the query instead
   *  of silently widening it to every scope (upstream's comment). */
  scopeType?: AuditScopeType;
  scopeId?: string | number;
  origin?: AuditOrigin;
  /** Keyset cursor: the (created_unix, id) pair of the last row of the
   *  previous page — exact continuation across equal-timestamp rows (upstream
   *  paginates with ListOptions OFFSET; ours is the D1 keyset idiom §4.1
   *  names, and it orders `timestamp_unix [DESC|ASC], id [DESC|ASC]` like
   *  upstream ToOrders). */
  cursor?: { createdUnix: Date; id: number };
  sort?: AuditEventSort;
  /** Page size; default 30, capped at 50 (the DEFAULT/MAX_PAGE_SIZE family). */
  limit?: number;
}

export async function findAuditEvents(
  db: DrizzleD1Database,
  query: AuditEventQuery = {},
): Promise<AuditEventRow[]> {
  const conditions: SQL[] = [];
  if (query.action !== undefined && query.action !== "") {
    conditions.push(eq(auditEvents.action, query.action));
  } else if (query.actionPrefix !== undefined && query.actionPrefix !== "") {
    conditions.push(like(auditEvents.action, `${query.actionPrefix}:%`));
  }
  if (query.actorId !== undefined && query.actorId !== 0) {
    const actorCond = or(eq(auditEvents.actorId, query.actorId), eq(auditEvents.impersonatorId, query.actorId));
    if (actorCond !== undefined) conditions.push(actorCond);
  }
  if (query.scopeType !== undefined) {
    conditions.push(eq(auditEvents.scopeType, query.scopeType));
  }
  if (query.scopeId !== undefined && query.scopeId !== "" && query.scopeId !== 0) {
    conditions.push(eq(auditEvents.scopeId, String(query.scopeId)));
  }
  if (query.origin !== undefined) {
    conditions.push(eq(auditEvents.origin, query.origin));
  }
  const ascending = query.sort === "timestamp_asc";
  if (query.cursor !== undefined) {
    const c = query.cursor.createdUnix;
    // Exact keyset continuation: (created_unix, id) tuple compare — no row
    // skipped nor repeated when a page boundary splits same-second events.
    const cursorCond = ascending
      ? or(
          gt(auditEvents.createdUnix, c),
          and(eq(auditEvents.createdUnix, c), gt(auditEvents.id, query.cursor.id)),
        )
      : or(
          lt(auditEvents.createdUnix, c),
          and(eq(auditEvents.createdUnix, c), lt(auditEvents.id, query.cursor.id)),
        );
    if (cursorCond !== undefined) conditions.push(cursorCond);
  }
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 50);
  const order = ascending
    ? [asc(auditEvents.createdUnix), asc(auditEvents.id)]
    : [desc(auditEvents.createdUnix), desc(auditEvents.id)];
  return db
    .select()
    .from(auditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...order)
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Retention (§4.3) — the demo-sweep producer/consumer shape
// ---------------------------------------------------------------------------

/** Ratified default (§7 item 4): 90 days. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

/** The REPO_TASKS message kind the producer enqueues. */
export interface AuditRetentionMessage {
  kind: "audit-retention";
}

export function isAuditRetentionMessage(value: unknown): value is AuditRetentionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AuditRetentionMessage).kind === "audit-retention"
  );
}

/**
 * The env slice the retention pair touches. `AUDIT_RETENTION_DAYS` is
 * OPTIONAL here on purpose (the DemoSweepProducerEnv posture): the var is not
 * yet in the generated Env (the wrangler.jsonc.example line lands with the
 * consumer-arm wiring — see the module report), so the absent case must stay
 * expressible and the generated Env satisfies this structurally once declared.
 */
export type AuditRetentionEnv = Partial<Pick<Env, "DB" | "REPO_TASKS">> & {
  /** Positive integer arms the producer and carries the window (days);
   *  absent or anything else → OFF — fail-closed (the demoModeEnabled
   *  posture: a typo must never arm a deletion sweep). */
  AUDIT_RETENTION_DAYS?: string;
};

/**
 * The retention window from the config var: a positive integer string → that
 * many days; absent/invalid/zero/negative → null (0 also disarms, mirroring
 * upstream DeleteOldEvents' "keeping everything if it is not positive",
 * audit_event.go:146-149).
 */
export function auditRetentionDaysFromEnv(env: { AUDIT_RETENTION_DAYS?: string }): number | null {
  const raw = env.AUDIT_RETENTION_DAYS;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const days = Number.parseInt(raw, 10);
  return days > 0 ? days : null;
}

/** Per-delete page size — the bounded bite the consumer takes per statement. */
export const AUDIT_PRUNE_PAGE_SIZE = 500;
/** Page cap per invocation; remaining pages prune on the queue redelivery
 *  (the work is idempotent — every page only touches rows older than cut). */
export const AUDIT_PRUNE_MAX_PAGES = 40;

/**
 * The cron producer (§4.3): DISARMED (return 0 before any I/O) unless
 * `AUDIT_RETENTION_DAYS` holds a positive integer; then ONE indexed
 * existence probe (`created_unix < cut` LIMIT 1 — idx_audit_event_created)
 * and, only when expired rows exist, ONE `{kind: "audit-retention"}` message
 * on REPO_TASKS. SELECT + enqueue ONLY — the delete runs in the consumer
 * (AGENTS.md: crons enqueue, consumers do the work). No CAS claim on purpose
 * (the demo-sweep posture): the consumer's prune is idempotent and drains
 * every expired row, so a duplicate message is absorbed as a no-op.
 * Returns the number of messages enqueued (0 or 1).
 */
export async function enqueueDueAuditRetention(
  env: AuditRetentionEnv,
  options: { now?: Date } = {},
): Promise<number> {
  // THE GATE — before the first D1 read, before the first queue send, before
  // any log line: a var-less deployment's tick is a silent no-op.
  const days = auditRetentionDaysFromEnv(env);
  if (days === null) return 0;
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Armed but unbound is a config bug — fail loud (the demo producer's
    // posture); the generated Env types the bindings required, this is the
    // fail-closed runtime defense.
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the audit retention producer cannot enqueue");
  }
  const cut = new Date((options.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  // The producer takes the RAW binding (queue-consumer/cron shape, the
  // demo-sweep posture) and wraps drizzle here — callers never pre-wrap.
  const due = await drizzle(db)
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(lt(auditEvents.createdUnix, cut))
    .limit(1);
  if (due.length === 0) {
    console.log(`[audit-retention] 0 due (window ${days}d, cut ${cut.toISOString()})`);
    return 0;
  }
  await queue.sendBatch([{ body: { kind: "audit-retention" } satisfies AuditRetentionMessage }]);
  console.log(`[audit-retention] enqueued 1 sweep (window ${days}d, cut ${cut.toISOString()})`);
  return 1;
}

/**
 * The queue consumer (§4.3): delete `audit_event` rows older than the window
 * in bounded pages until drained (or the per-invocation page cap — the
 * redelivery continues; every page only touches rows older than cut, so the
 * work is idempotent). The window is the same config var, defaulting to 90
 * when absent (the consumer runs only where an armed producer enqueued, but
 * the default keeps the arm-and-window pair honest if wiring drifts).
 * Returns the number of rows deleted.
 */
export async function pruneExpiredAuditEvents(
  env: AuditRetentionEnv,
  options: { now?: Date; days?: number; pageSize?: number; maxPages?: number } = {},
): Promise<number> {
  const db = env.DB;
  if (db === undefined) {
    throw new Error("DB not bound (wrangler.jsonc); the audit retention consumer cannot prune");
  }
  const days = options.days ?? auditRetentionDaysFromEnv(env) ?? DEFAULT_AUDIT_RETENTION_DAYS;
  const pageSize = options.pageSize ?? AUDIT_PRUNE_PAGE_SIZE;
  const maxPages = options.maxPages ?? AUDIT_PRUNE_MAX_PAGES;
  const cut = new Date((options.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  // Raw binding in, drizzle wrapped here (the demo-sweep producer posture).
  const d1 = drizzle(db);
  let deleted = 0;
  for (let page = 0; page < maxPages; page++) {
    // Paged delete by id subquery (drizzle all the way down — no hand-written
    // SQL): each statement removes at most `pageSize` expired rows.
    const rows = await d1
      .delete(auditEvents)
      .where(
        inArray(
          auditEvents.id,
          d1
            .select({ id: auditEvents.id })
            .from(auditEvents)
            .where(lt(auditEvents.createdUnix, cut))
            .limit(pageSize),
        ),
      )
      .returning({ id: auditEvents.id });
    deleted += rows.length;
    if (rows.length < pageSize) break;
  }
  console.log(`[audit-retention] pruned ${deleted} rows (window ${days}d, cut ${cut.toISOString()})`);
  return deleted;
}
