/**
 * The demo sweep producer + gate (SPEC-0014 §2/§3.1 — milestone M1). The
 * public reference demo (`cf-gitea-demo.aiapp.run`) is display-purpose only
 * and is periodically cleaned, Gitea's own demo posture; the engineering
 * invariant is that cleanup is STRUCTURALLY impossible to arm in a default
 * (self-hosted) deployment:
 *
 *   > A self-hosted deployment with the default config NEVER schedules
 *   > cleanup, NEVER deletes user data, NEVER rate-limits beyond the
 *   > platform plan (SPEC-0014 §2 hard invariant).
 *
 * The mechanism (§3, verbatim): hourly cron → REPO_TASKS messages of the
 * `{kind: "demo-sweep", repoId}` shape → the EXISTING serialized consumer
 * (handleRepoTasks, src/repos/purge.ts) drives the EXISTING delete cascade
 * (RepoService.deleteRepository, SPEC-0003 §2.5.5). Never a new queue, never
 * a new deletion path — this module only SELECTs and enqueues; the deletion
 * is the queue consumer's, with its own CPU/wall budget.
 *
 * Everything here begins with the §2 gate: `demoModeEnabled` reads
 * `DEMO_MODE` absent-safe-FALSE (the user-accounts `ALLOW_SIGNUP` pattern,
 * services/user-accounts.ts — strict polarity per §6.8: only the exact
 * string "true" arms; unset/`"false"`/`"1"`/`"on"`/typos all stay OFF) and
 * `enqueueDueDemoSweeps` returns before its FIRST D1 read or queue send when
 * the gate is off — zero reads, zero sends, zero log lines (§2 invariant arm
 * 1, pinned by demo-sweep.test.ts which runs the gate-off battery first).
 * The gate value is read per-invocation from `env` — no module-level mutable
 * state (AGENTS.md Workers rules); arming is a wrangler.jsonc vars edit +
 * redeploy, never a runtime toggle.
 *
 * The CONSUMER arm deliberately does NOT re-check the gate (see purge.ts):
 * messages only exist because an armed producer enqueued them, and a gate
 * flip-off must not strand already-enqueued sweep work — the §2 invariant is
 * about scheduling, which only the producer does.
 *
 * ## Mount record (MOUNTED at 15e2b62 — the wiring HANDOFF is retired)
 *
 * index.ts's `scheduled` handler is the single delegation
 * `await handleScheduledCron(controller, env)`. The dispatcher
 * reproduces the pre-M1 inline behavior on every non-hourly entry — the
 * mirror producers run unconditionally, joined by the TWO actions-stop
 * extension blocks (the probe-gated actions-zombie producer, upstream's
 * own always-on `stop_zombie_tasks` @every 5m, cron/tasks_actions.go:26-35
 * — the SPEC-0016 §4.4 packages ratification shape and the FOURTH
 * sanctioned extension; the actions-endless producer, upstream's
 * `stop_endless_tasks`, tasks_actions.go:38-45 — the FIFTH) — and runs
 * EIGHT producer blocks (NINE producer calls) on the hourly "0 * * * *"
 * entry (carried by wrangler.jsonc.example): the (self-gated) demo
 * producer, the (self-gated) audit-retention producer (the FIRST
 * sanctioned extension), the (probe-gated, ratified non-demo-gated)
 * packages-cleanup producer (the SECOND), the (self-gated on the
 * ACTIONS_*_RETENTION_DAYS trio) actions-retention producer (the THIRD),
 * the probe-gated auto-merge due-scan producer (the 58f9890 fold), the
 * actions-abandoned + ephemeral block (the SIXTH — the ungated
 * `cancel_abandoned_jobs` + `cleanup_ephemeral_runners` pair;
 * SPEC-0015 §4.3 + SPEC-0016 §4.4 + SPEC-0012 §4.5 — SIX sanctioned
 * extensions total), the probe-gated webhook-maintenance producer
 * (SPEC-0005 §4.9 as-built — upstream's own registered
 * `cleanup_hook_task_table` task, services/cron/tasks_basic.go:124-135;
 * parity-placed with the ratified non-demo-gated packages shape), and the
 * probe-gated actions-schedule producer (upstream's own registered
 * `start_schedule_tasks`, cron/tasks_actions.go:55-67, enabled default —
 * the SEVENTH sanctioned extension; the due-derivation and its recorded
 * divergences live in services/actions/trigger.ts's schedule section).
 * Thirteen producer calls across the two entries; the services/cron-state.ts
 * CRON_ARMS census gains the matching `cleanup_hook_task_table` row as
 * this block's integration follow-up (the census list stays pinned by
 * cron-state.test.ts until then; see the marked blocks in
 * handleScheduledCron).
 * Tests exercise `handleScheduledCron` / `enqueueDueDemoSweeps` / the
 * purge.ts consumer arms directly with fabricated ScheduledControllers —
 * the delegation itself is one await.
 */

import { asc, eq, inArray, isNull, lt, or, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users, webhookDeliveries } from "../db/schema";
import { enqueueDueAuditRetention } from "./audit";
import { enqueueDueAutoMergeChecks } from "./pull-automerge";
import { enqueueDueActionsRetention, enqueueDueZombieStops } from "./actions/retention";
import { enqueueDueAbandonedJobCancels, enqueueDueEndlessTaskStops, enqueueDueEphemeralCleanup } from "./actions/sweeps";
import type { ActionsScheduleTriggerMessage } from "./actions/trigger";
import { enqueueDuePackagesCleanup } from "./packages/cleanup";
import { enqueueDueMirrorSyncs } from "./mirror/sync";
import { enqueueDuePushMirrorSyncs } from "./mirror/push-sync";

/** The hourly cron entry the demo producer dispatches on (§3.1). The
 *  standing 10-minute step entry (`every 10 minutes` — spelled out here per
 *  the sync.ts:68-70 convention: the literal cron string would terminate
 *  this comment) keeps firing the mirror producers exactly
 *  as today; at :00 both entries fire as SEPARATE scheduled invocations,
 *  each carrying its own cron string. */
export const DEMO_SWEEP_CRON = "0 * * * *";

/**
 * Retention: 72 hours, aged on `repositories.created_at` (the row-creation
 * unix timestamp set explicitly by RepoService.create — NOT updated_at:
 * last-activity would let a one-push-then-abandoned 10 GiB repo live
 * forever, §3.3). In code, deliberately NOT an env var — a second knob
 * would invite a default-config deployment to shorten retention and breach
 * the §2 invariant's spirit (OQ-5). One gate, one constant, in code.
 */
export const DEMO_RETENTION_HOURS = 72;

/** Per-tick page size (§3.1 — the mirror producer's LIMIT 50, sync.ts:885).
 *  The deliberate throttle: the demo drains over hours, never bursts (§6.10). */
export const DEMO_SWEEP_PAGE_LIMIT = 50;

// ---------------------------------------------------------------------------
// The gate (§2) + env slice
// ---------------------------------------------------------------------------

/**
 * The env slice the producer touches, picked from the GENERATED Env (drift
 * surfaces at the type level — the MirrorSyncEnv inherited-not-redeclared
 * lesson, sync.ts:122-147). Both bindings are OPTIONAL here on purpose (the
 * FirstRunEnv.ALLOW_SIGNUP posture, services/user-accounts.ts:55-68): the
 * absent case must stay expressible so the gate-off invariant tests can
 * drive unset/unbound structurally, and the generated Env (whose members
 * are required) satisfies this structurally. The runtime guards remain as
 * the fail-closed defense (the MIRROR_SYNC_QUEUE guard posture,
 * sync.ts:873-875).
 */
export type DemoSweepProducerEnv = Partial<Pick<Env, "DB" | "REPO_TASKS">> & {
  /** `"true"` arms the sweep (SPEC-0014 §2). Absent or anything else →
   *  OFF — fail-closed (§6.8). */
  DEMO_MODE?: string;
};

/**
 * The gate, absent-safe: FALSE unless the var is EXACTLY "true" (§6.8 —
 * stricter than ALLOW_SIGNUP's lenient "1": a demo flag that fires on
 * "1"/"on"/"TRUE" could arm cleanup on an operator typo, and the invariant
 * is fail-closed. The runbook names the exact accepted value). No trim, no
 * lower-casing: the comparison is the strict string.
 */
export function demoModeEnabled(env: { DEMO_MODE?: string }): boolean {
  return env.DEMO_MODE === "true";
}

// ---------------------------------------------------------------------------
// The queue message + narrowing guard (the MirrorSyncMessage shape, §3.2)
// ---------------------------------------------------------------------------

/** The only thing the producer puts on REPO_TASKS (§3.2). No CAS claim on
 *  the enqueue side (unlike the mirror producer): the consumer DELETES the
 *  repositories row, so row-deletion IS the claim — the next hour's SELECT
 *  simply misses it, and a duplicate message is absorbed idempotently by
 *  the consumer arm (§3.4). */
export interface DemoSweepMessage {
  kind: "demo-sweep";
  repoId: string;
}

export function isDemoSweepMessage(value: unknown): value is DemoSweepMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DemoSweepMessage).kind === "demo-sweep" &&
    typeof (value as DemoSweepMessage).repoId === "string"
  );
}

// ---------------------------------------------------------------------------
// The hourly cron producer (§3.1) — the enqueueDueMirrorSyncs shape
// ---------------------------------------------------------------------------

/**
 * The demo producer (§3.1): GATE first (return 0 before any I/O when off —
 * the §2 invariant arm the tests pin with a spy queue AND a forbidden D1),
 * then SELECT candidates and enqueue one `{kind: "demo-sweep", repoId}`
 * message per candidate via `REPO_TASKS.sendBatch` (≤ 100/call — the mirror
 * producer's chunking, sync.ts:899-901). CPU discipline: SELECT + enqueue
 * ONLY (the 10-minute mirror producer's shape) — the deletion runs in the
 * REPO_TASKS consumer, which gets its own queue-consumer budget.
 *
 * Candidate selection (§3.1 step 2): `repositories.created_at < now - 72 h`
 * (hour resolution), LEFT JOIN `users` on `owner_id` (the indexed
 * `repositories_owner_id_idx` join column) keeping rows where the owner is
 * NOT a RESOLVABLE site admin — either the join resolves no users row
 * (`users.id IS NULL`, the LEFT JOIN's null-extension marker: BOTH a NULL
 * `owner_id` — a NULL key never satisfies the join equality — AND a DANGLING
 * `owner_id` whose users row is gone, the day-one production finding,
 * docs/reviews/demo-day1-2026-10-28.md §5.3; no exempting principal exists
 * → swept, fail-safe, exactly the consumer's re-check posture in
 * purge.ts handleDemoSweep where `owner?.isAdmin === true` is false for an
 * unresolved owner) OR the resolved owner is not a site admin
 * (`users.is_admin = false` — admin-owned repos are exempt, and the demo's
 * standing fixtures live under the bootstrap admin precisely so they
 * survive, §6.2). The ORIGINAL predicate's third arm `owner_id IS NULL` was
 * wrong as the disjunct testing ownership: for a dangling id the column
 * holds a VALUE (arm false), the join's `users.is_admin` is NULL, and
 * `NULL = false` is UNKNOWN in SQL three-valued logic — `FALSE OR UNKNOWN`
 * never satisfies the WHERE, so the row escaped every tick, permanently.
 * `users.id IS NULL` subsumes that arm (a NULL owner_id null-extends the
 * join too). Oldest first, LIMIT 50 — a backlog (e.g. the §6.4 gate-flip
 * backlog) drains oldest-first over hours.
 *
 * NO CAS claim, on purpose (§3.1): the consumer's row deletion is the
 * claim. Returns the number of sweep messages enqueued.
 */
export async function enqueueDueDemoSweeps(
  env: DemoSweepProducerEnv,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  // THE GATE (§2) — before the first D1 read, before the first queue send,
  // before any log line: a default deployment's hourly invocation is a
  // silent no-op (§6.8: the sweep log's absence pins the arm).
  if (!demoModeEnabled(env)) return 0;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const limit = options.limit ?? DEMO_SWEEP_PAGE_LIMIT;
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Armed but unbound is a config bug — fail loud (the MIRROR_SYNC_QUEUE
    // guard posture, sync.ts:873-875); the generated Env types the bindings
    // required, this is the fail-closed runtime defense.
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the demo sweep producer cannot enqueue");
  }
  const cut = new Date((now - DEMO_RETENTION_HOURS * 60 * 60) * 1000);
  const due = await drizzle(db)
    .select({
      id: repositories.id,
      // §4.3 (M2): the observe-only size report rides THIS select — settle-time
      // accounting already maintains size_kb (services/repo-size.ts), so the
      // roll-up is three free columns on an existing query, never a second
      // read. The name rides along to aim the runbook at the largest repo.
      sizeKb: repositories.sizeKb,
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
    })
    .from(repositories)
    .leftJoin(users, eq(repositories.ownerId, users.id))
    // Sweep-eligible = owner NOT resolvable-as-admin (§3.1 step 2; the day-one
    // §5.3 fix). `users.id IS NULL` is the LEFT JOIN's null-extension marker
    // (users.id is the PK — never NULL in a matched row): it covers BOTH a
    // NULL owner_id and a DANGLING owner_id (users row gone — for which
    // `users.is_admin = false` reads NULL and `NULL = false` is UNKNOWN, the
    // three-valued-logic gap the production row escaped through). No
    // resolvable owner ⇒ no exempting principal ⇒ swept (fail-safe, the same
    // posture as the consumer's handleDemoSweep re-check); a resolved owner
    // must be a non-admin.
    .where(and(lt(repositories.createdAt, cut), or(isNull(users.id), eq(users.isAdmin, false))))
    .orderBy(asc(repositories.createdAt))
    .limit(limit);

  const messages: DemoSweepMessage[] = due.map((row) => ({ kind: "demo-sweep", repoId: row.id }));
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100).map((message) => ({ body: message })));
  }
  // EVERY sweep batch logs counts (§3.1 step 4) — including 0-eligible
  // ticks, whose compact one-liner proves the sweep ran. Gate-off ticks log
  // NOTHING (the early return above) — the default deployment's log stays
  // sweep-silent. The §4.3 size roll-up rides the same line (observe-only —
  // OQ-4 kept the pre-push refusal OUT of the hot path): the batch's total
  // KiB and the largest repo (named) leave the log.
  const totalKb = due.reduce((sum, row) => sum + row.sizeKb, 0);
  let largest: { sizeKb: number; name: string } | null = null;
  for (const row of due) {
    if (largest === null || row.sizeKb > largest.sizeKb) {
      largest = { sizeKb: row.sizeKb, name: `${row.ownerNamespace}/${row.slug}` };
    }
  }
  const sizeReport =
    largest === null ? "size total=0 KiB largest=0 KiB (-)" : `size total=${totalKb} KiB largest=${largest.sizeKb} KiB (${largest.name})`;
  console.log(`[demo-sweep] enqueued ${messages.length} of ${due.length} eligible (cut ${cut.toISOString()}) ${sizeReport}`);
  return messages.length;
}

// ---------------------------------------------------------------------------
// The webhook-maintenance producer (SPEC-0005 §4.9 as-built + §3.6) — the
// enqueueDuePackagesCleanup probe shape
// ---------------------------------------------------------------------------

/**
 * The one REPO_TASKS message the webhook-maintenance producer enqueues: the
 * trigger for the serialized consumer arm (repos/purge.ts) to run BOTH
 * webhook-delivery sweeps — `sweepStuckDeliveries` (§3.6 stuck-row pass,
 * webhooks/dlq.ts) and `cleanupWebhookDeliveries` (§4.9 log-growth control,
 * upstream `CleanupHookTaskTable`) — with its own queue-consumer budget
 * ("crons enqueue, consumers do the work", AGENTS.md Workers rules).
 */
export interface WebhookMaintenanceMessage {
  kind: "webhook-maintenance";
}

export function isWebhookMaintenanceMessage(value: unknown): value is WebhookMaintenanceMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as WebhookMaintenanceMessage).kind === "webhook-maintenance"
  );
}

/**
 * The env slice the webhook-maintenance producer touches (the
 * DemoSweepProducerEnv posture — bindings OPTIONAL here so tests can drive
 * unbound structurally; the generated Env, whose members are required,
 * satisfies this structurally, and the runtime guard below stays as the
 * fail-closed defense).
 */
export type WebhookMaintenanceProducerEnv = Partial<Pick<Env, "DB" | "REPO_TASKS">>;

/**
 * The stuck threshold the probe arms on — webhooks/dlq.ts
 * `sweepStuckDeliveries`' default (15 min, far past the 5 s delivery
 * timeout). Kept in lockstep with dlq.ts's default on purpose: the probe and
 * the sweep MUST agree on "stuck" (a probe threshold past the sweep's would
 * enqueue for rows the sweep then no-ops; the reverse would let wedged rows
 * age past the probe between ticks). A row in `delivering` past this means a
 * delivery consumer died between the §3.6 pending→delivering CAS and the
 * outcome write — the queue redelivery CAS no-op-acks those forever, so the
 * sweep is the designed way out.
 */
export const WEBHOOK_STUCK_AFTER_SECONDS = 900;

/**
 * The cleanup age threshold the probe arms on — webhooks/dlq.ts
 * `cleanupWebhookDeliveries`' `olderThanDays` default (30, §4.9, upstream's
 * `CleanupHookTaskTable` OlderThan window). Same lockstep note as above.
 */
export const WEBHOOK_DELIVERY_AGE_DAYS = 30;

/**
 * dlq.ts's terminal set (private there — mirrored locally; keeping dlq.ts
 * untouched was the wiring constraint). Drift can only DE-ARM the probe
 * early, never delete anything the cleanup would keep — the consumer re-checks
 * every predicate at consume time.
 */
const WEBHOOK_TERMINAL_STATES = ["delivered", "skipped", "failed"] as const;

/**
 * The webhook-maintenance producer (SPEC-0005 §4.9 as-built): TWO existence
 * probes gate ONE enqueue —
 *
 *   1. the stuck-sweep probe: any `delivering` row older than
 *      WEBHOOK_STUCK_AFTER_SECONDS (sweepStuckDeliveries' exact predicate);
 *   2. the cleanup probe: any TERMINAL row older than WEBHOOK_DELIVERY_AGE_DAYS
 *      (cleanupWebhookDeliveries' age-rule predicate — the newest-N-per-webhook
 *      rule has no cheap existence probe and rides any trigger of this message).
 *
 * Neither hits → zero sends: a quiet deployment's hourly tick costs two
 * LIMIT-1 reads (the packages-cleanup producer's probe posture; the
 * deliveries table has no (state, created_unix) index, but its size is held
 * near the §4.9 keep-set by the cleanup itself, so the scan stays bounded).
 * Work exists → ONE `{kind: "webhook-maintenance"}` message on REPO_TASKS.
 * NOT demo-gated (upstream's `cleanup_hook_task_table` never was — parity
 * with the ratified non-demo-gated cleanup_packages). No CAS claim: both
 * sweeps re-check "stuck"/"old" at consume time and are idempotent, so a
 * duplicate message is absorbed as a no-op. Returns the number of messages
 * enqueued (0 or 1).
 */
export async function enqueueDueWebhookMaintenance(
  env: WebhookMaintenanceProducerEnv,
  options: { now?: Date; stuckAfterSeconds?: number; olderThanDays?: number } = {},
): Promise<number> {
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Unbound bindings are a config bug — fail loud (the packages-cleanup
    // producer's posture); the generated Env types the bindings required,
    // this is the fail-closed runtime defense.
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the webhook maintenance producer cannot probe");
  }
  const now = options.now ?? new Date();
  const stuckAfterSeconds = options.stuckAfterSeconds ?? WEBHOOK_STUCK_AFTER_SECONDS;
  const olderThanDays = options.olderThanDays ?? WEBHOOK_DELIVERY_AGE_DAYS;
  const stuckCut = new Date(now.getTime() - stuckAfterSeconds * 1000);
  const ageCut = new Date(now.getTime() - olderThanDays * 86_400_000);
  // Raw binding in, drizzle wrapped here (the demo-sweep producer posture).
  const d1 = drizzle(db);
  // Probe 1 — sweepStuckDeliveries' exact predicate (webhooks/dlq.ts): a
  // `delivering` row past the stuck threshold. The sweep unblocks the §3.6
  // redelivery paths, so it gates on its own.
  const stuckDue = await d1
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.state, "delivering"), lt(webhookDeliveries.createdAt, stuckCut)))
    .limit(1);
  // Probe 2 — cleanupWebhookDeliveries' age rule (the upstream
  // `is_delivered`-guarded OlderThan sweep): terminal rows only, past the
  // age cutoff. In-flight/pending rows never arm it.
  const agedDue = await d1
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.state, [...WEBHOOK_TERMINAL_STATES]), lt(webhookDeliveries.createdAt, ageCut)))
    .limit(1);
  if (stuckDue.length === 0 && agedDue.length === 0) {
    console.log(`[webhook-maintenance] 0 due (stuck > ${stuckAfterSeconds}s, terminal older than ${olderThanDays}d)`);
    return 0;
  }
  await queue.sendBatch([{ body: { kind: "webhook-maintenance" } satisfies WebhookMaintenanceMessage }]);
  console.log(
    `[webhook-maintenance] enqueued 1 sweep (stuck=${stuckDue.length > 0} aged=${agedDue.length > 0}, stuck > ${stuckAfterSeconds}s, terminal older than ${olderThanDays}d)`,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// The actions schedule producer (SPEC-0012 — upstream's registered
// `start_schedule_tasks`, cron/tasks_actions.go:55-67, enabled default) — the
// SEVENTH sanctioned extension's producer, riding the hourly entry
// ---------------------------------------------------------------------------

/**
 * The env slice the schedule producer touches (the WebhookMaintenanceProducerEnv
 * posture — bindings optional for the tests, the generated Env satisfies the
 * required shape, the runtime guard below is the fail-closed defense).
 */
export type ActionsScheduleProducerEnv = Partial<Pick<Env, "DB" | "REPO_TASKS">>;

/**
 * The schedule producer (upstream startTasks, services/actions/schedule_tasks.go:38-55):
 * ONE `{kind: "actions-trigger", repoId, scheduledUnix}` message per
 * actions-enabled repo — the consumer arm (handleActionsScheduleTrigger,
 * services/actions/trigger.ts) re-derives the due workflows from the
 * default-branch tree. Upstream registers parsed specs into
 * action_schedules/action_schedule_specs on every default-branch push and the
 * @every-1m ticker iterates those rows; the schedule pair is deferred storage
 * here (schema.ts), so the producer's probe is the candidate SELECT (non-
 * archived, non-empty, actions unit on — the DetectAndHandleSchedules +
 * startTask gates pulled INTO the probe) and the tree read happens
 * consume-side with its own queue budget ("crons enqueue, consumers do the
 * work"). NOT demo-gated and NOT var-gated (upstream's arm is enabled default
 * with no knob — the ratified non-demo-gated packages shape); zero sends on
 * an instance with no candidate repos. No CAS claim: the consumer's
 * payload-stamped `schedule_unix` dedupe absorbs redelivery AND a duplicate
 * enqueue of the same tick. Returns the number of messages enqueued.
 */
export async function enqueueDueActionSchedules(env: ActionsScheduleProducerEnv, options: { now?: Date } = {}): Promise<number> {
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    // Unbound bindings are a config bug — fail loud (the packages-cleanup
    // producer's posture); the generated Env types the bindings required,
    // this is the fail-closed runtime defense.
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the actions schedule producer cannot enqueue");
  }
  const scheduledUnix = Math.floor((options.now ?? new Date()).getTime() / 1000);
  // The candidate probe: DetectAndHandleSchedules' empty/archived skips
  // (notifier_helper.go:668-670) and startTask's unit gate
  // (schedule_tasks.go:112-121) as ONE indexed scan (repo_units.repo_id is
  // the unit table's lookup column).
  const candidates = await drizzle(db)
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.isArchived, false),
        eq(repositories.isEmpty, false),
        sql`EXISTS (SELECT 1 FROM repo_units WHERE repo_units.repo_id = ${repositories.id} AND repo_units.type = 'actions')`,
      ),
    )
    .orderBy(asc(repositories.id))
    .all();
  const messages: ActionsScheduleTriggerMessage[] = candidates.map((row) => ({
    kind: "actions-trigger",
    repoId: row.id,
    scheduledUnix,
  }));
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100).map((message) => ({ body: message })));
  }
  console.log(`[actions-schedule] enqueued ${messages.length} repo passes for tick ${scheduledUnix}`);
  return messages.length;
}

// ---------------------------------------------------------------------------
// The scheduled dispatch (§3.1) — see the mount record in the module header
// ---------------------------------------------------------------------------

/**
 * The cron dispatcher (§3.1): the hourly entry carries the demo
 * producer (which self-gates on DEMO_MODE before its first D1 read — gate
 * off → the whole invocation performs zero reads and zero sends, §2's
 * invariant arm 1), the audit-retention producer (self-gated on
 * AUDIT_RETENTION_DAYS), the packages-cleanup producer (ratified
 * non-demo-gated — SPEC-0016 §4.4 — but probe-gated: no enabled rule AND no
 * expired orphans → zero sends) and the actions-retention producer
 * (self-gated on the ACTIONS_*_RETENTION_DAYS trio — SPEC-0012 §4.5: no var
 * set → zero reads and zero sends), the auto-merge due-scan producer
 * (probe-shaped, ungated — the 58f9890 fold) and the webhook-maintenance
 * producer (probe-gated, never var-gated — SPEC-0005 §4.9 as-built: no stale
 * `delivering` row AND no over-age terminal row → zero sends), and the
 * actions-schedule producer (probe-shaped, never var-gated — upstream's
 * `start_schedule_tasks`, the trigger.ts schedule section's due-derivation);
 * every OTHER entry — the standing
 * 10-minute step entry and anything a future config adds — runs the mirror
 * producers exactly as the inline handler always has: unconditional,
 * gate-independent (their CAS guard absorbs any :00 overlap, sync.ts:890-898),
 * joined by the probe-gated actions-zombie producer (upstream's always-on
 * stop_zombie_tasks cadence). The step entry therefore NEVER triggers a
 * sweep, in either gate state.
 */
export async function handleScheduledCron(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === DEMO_SWEEP_CRON) {
    await enqueueDueDemoSweeps(env, {});
    // --- BEGIN audit-retention producer block (SPEC-0015 §4.3; the FIRST
    // --- sanctioned extension of this dispatcher) -------------------------
    // Rides the hourly entry (the standing cadence closest to the SPEC's
    // daily producer — no new cron entry in wrangler.jsonc). Fully self-
    // gated in services/audit.ts: without a positive-integer
    // AUDIT_RETENTION_DAYS var it returns before its FIRST D1 read and
    // before any queue send (the demoModeEnabled posture), so a default
    // deployment's tick stays a silent no-op; armed, it is ONE indexed
    // existence probe + at most ONE enqueue ("crons enqueue, consumers do
    // the work" — the delete runs in the REPO_TASKS consumer).
    await enqueueDueAuditRetention(env, {});
    // --- END audit-retention producer block --------------------------------
    // --- BEGIN packages-cleanup producer block (SPEC-0016 §4.4; the SECOND
    // --- sanctioned extension of this dispatcher) --------------------------
    // Ratified NON-demo-gated (ratification 5): this is upstream's own
    // midnight job ([cron.cleanup_packages] ENABLED=true OLDER_THAN=24h),
    // not the demo sweep's data-deletion invariant — it deletes only
    // unreferenced blobs past the window and rule-matched versions, exactly
    // what upstream self-hosters get. It performs ZERO queue sends unless
    // work exists: services/packages/cleanup.ts probes an enabled rule, an
    // expired unreferenced blob and an orphan spool object (two indexed
    // LIMIT-1 reads + one bounded R2 list page) before its single enqueue;
    // the delete runs in the REPO_TASKS consumer (handlePackagesCleanup —
    // the purge.ts fold, see the module report). Probe failures are logged
    // and swallowed HERE: a broken tail arm must not fail the hourly
    // invocation (the demo/audit producers above already ran) — the next
    // tick re-probes, and console.error keeps it visible without breaking
    // the quiet-tick log posture.
    try {
      await enqueueDuePackagesCleanup(env, {});
    } catch (error) {
      console.error(
        `[package-cleanup] producer probes failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // --- END packages-cleanup producer block -------------------------------
    // --- BEGIN actions-retention producer block (SPEC-0012 §4.5; the THIRD
    // --- sanctioned extension of this dispatcher) --------------------------
    // The strict-polarity trio ACTIONS_{ARTIFACT,LOG,RUN}_RETENTION_DAYS
    // (upstream defaults 90/365/400 — modules/setting/actions.go:15-21) gates
    // it fully-self-gated in services/actions/retention.ts: with no var set
    // (a default deployment) it returns before its FIRST D1 read and before
    // any queue send (the demoModeEnabled/audit posture — upstream's cleanup
    // is always-on with the defaults, ours deletes only where an operator set
    // a var); armed, it is at most ONE indexed LIMIT-1 probe per armed arm +
    // at most ONE enqueue ("crons enqueue, consumers do the work" — the sweep
    // runs in the REPO_TASKS consumer arm, runActionsRetention). Probe
    // failures are logged and swallowed HERE: a broken tail arm must not fail
    // the hourly invocation (the packages block's rationale) — the next tick
    // re-probes.
    try {
      await enqueueDueActionsRetention(env, {});
    } catch (error) {
      console.error(
        `[actions-retention] producer probes failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // --- END actions-retention producer block ------------------------------
    // --- BEGIN auto-merge producer block (the 58f9890 fold; upstream's
    // --- queue module holds no cron of its own — the DUE scan needs a
    // --- tick; rides the hourly entry, probe-shaped: one indexed SELECT
    // --- LIMIT 50 + sendBatch, no CAS — the row IS the claim (the
    // --- demo-sweep posture). Self-healing on failure (the catch logs;
    // --- the next tick rescans).
    try {
      await enqueueDueAutoMergeChecks(env, {});
    } catch (error) {
      console.error("[auto-merge] producer probe failed (retrying next tick):", error);
    }
    // --- END auto-merge producer block -------------------------------------
    // --- BEGIN actions-abandoned + ephemeral producer block (SPEC-0012
    // --- §4.5, the parity review §5; the SIXTH sanctioned extension) -------
    // Upstream's cancel_abandoned_jobs (@every 6h) and the ephemeral half
    // of Cleanup (@midnight) — both RunAtStart, enabled default, no
    // retention knob (cron/tasks_actions.go:46-55, cleanup.go:144-165).
    // They ride the HOURLY entry: both are idempotent "older than X" /
    // state-based passes whose hourly granularity only changes kill
    // latency, not behavior (the module header's ratified divergence).
    // The ephemeral producer is deliberately UNGATED from the retention
    // arming above (parity review item 3c: upstream runs it inside every
    // nightly Cleanup unconditionally) — it deletes only ephemeral runner
    // rows whose task set holds no live status, never user data.
    try {
      await enqueueDueAbandonedJobCancels(env, {});
      await enqueueDueEphemeralCleanup(env);
    } catch (error) {
      console.error(
        `[actions-sweeps] producer probes failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // --- END actions-abandoned + ephemeral producer block -------------------
    // --- BEGIN webhook-maintenance producer block (SPEC-0005 §4.9 as-built;
    // --- upstream's own registered `cleanup_hook_task_table` task,
    // --- services/cron/tasks_basic.go:124-135) ------------------------------
    // TWO existence probes (webhooks/dlq.ts sweepStuckDeliveries' stale-
    // `delivering` predicate past WEBHOOK_STUCK_AFTER_SECONDS;
    // cleanupWebhookDeliveries' terminal-age predicate past
    // WEBHOOK_DELIVERY_AGE_DAYS) gate ONE {kind: "webhook-maintenance"}
    // enqueue on REPO_TASKS; the serialized consumer arm (repos/purge.ts)
    // runs the stuck sweep FIRST — it unblocks the §3.6 redelivery paths a
    // consumer crashed post-CAS wedges — then the cleanup, and acks.
    // NOT demo-gated (upstream's arm never was; parity with the ratified
    // non-demo-gated cleanup_packages) and probe-gated: zero sends on a
    // quiet instance. Swallowed failures keep the hourly invocation intact
    // (the tail-arm rationale); the next tick re-probes.
    try {
      await enqueueDueWebhookMaintenance(env, {});
    } catch (error) {
      console.error(
        `[webhook-maintenance] producer probes failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // --- END webhook-maintenance producer block -----------------------------
    // --- BEGIN actions-schedule producer block (SPEC-0012; upstream's own
    // --- registered `start_schedule_tasks` @every 1m enabled default,
    // --- cron/tasks_actions.go:55-67; the SEVENTH sanctioned extension) ----
    // ONE D1 SELECT of the actions-enabled repos (non-archived, non-empty —
    // the DetectAndHandleSchedules/startTask gates pulled into the probe)
    // arms the tick: one {kind: "actions-trigger", repoId, scheduledUnix}
    // message per candidate, and the REPO_TASKS consumer arm
    // (handleActionsScheduleTrigger, services/actions/trigger.ts) re-derives
    // the due `on: schedule` entries from the default-branch tree with its
    // own queue budget. Upstream registers parsed specs at push time and
    // iterates them per minute; the schedule pair is deferred storage, so
    // the tree is the registry and the hourly tick window (absorbing every
    // minute-resolution spec) is the cadence — the divergences are recorded
    // in trigger.ts's schedule section header. Not demo-gated, not var-gated
    // (upstream's arm is enabled default with no knob); zero candidates →
    // zero sends. Swallowed failures keep the hourly invocation intact (the
    // tail-arm rationale); the next tick re-probes.
    try {
      await enqueueDueActionSchedules(env, {});
    } catch (error) {
      console.error(
        `[actions-schedule] producer probe failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // --- END actions-schedule producer block --------------------------------
    return;
  }
  // The mirror producers, exactly as today (index.ts scheduled) — the
  // pull-mirror SELECT+CAS+enqueue and the push-mirror twin.
  await enqueueDueMirrorSyncs(env, {});
  await enqueueDuePushMirrorSyncs(env, {});
  // --- BEGIN actions-zombie producer block (SPEC-0012 §4.5/§5.6; the FOURTH
  // --- sanctioned extension of this dispatcher) ---------------------------
  // Upstream's stop_zombie_tasks is NOT retention: an always-on @every 5m
  // cron (cron/tasks_actions.go:26-35, enabled default, no retention knob)
  // that stops running/cancelling tasks whose `updated` went quiet past
  // ZOMBIE_TASK_TIMEOUT (10 min) — so it rides this 10-minute step entry
  // (the standing cadence closest to upstream's), NOT the hourly entry, and
  // is NOT var-gated. It deletes no user data (the §2 invariant's scope is
  // data deletion, which only the retention/demo families perform) and is
  // probe-gated like the packages producer: zero sends unless a stale task
  // exists. Swallowed failures keep the mirror producers' invocation intact
  // (the tail-arm rationale); the next tick re-probes.
  try {
    await enqueueDueZombieStops(env, {});
  } catch (error) {
    console.error(
      `[actions-zombie] producer probe failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // --- END actions-zombie producer block ----------------------------------
  // --- BEGIN actions-endless producer block (SPEC-0012 §4.5, the parity
  // --- review §5; the FIFTH sanctioned extension) --------------------------
  // Upstream's stop_endless_tasks: @every 30m, RunAtStart, enabled default,
  // no retention knob (cron/tasks_actions.go:38-45). The step entry (10m)
  // is the standing cadence closest to it — same placement logic as the
  // zombie block above, and the same stop-family budget discipline applies
  // (an indexed LIMIT-1 probe, zero sends on a quiet instance). Not
  // var-gated (upstream's arm never was); deletes no user data.
  try {
    await enqueueDueEndlessTaskStops(env, {});
  } catch (error) {
    console.error(
      `[actions-endless] producer probe failed (retrying next tick): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // --- END actions-endless producer block ----------------------------------
}
