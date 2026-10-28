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
 * ## HANDOFF NOTE (SPEC-0014 §3.1 — src/index.ts is orchestrator-owned, so
 * this module ships the complete scheduled dispatcher instead):
 *
 *   1. src/index.ts gains:
 *        import { handleScheduledCron } from "./services/demo-sweep";
 *   2. The inline `scheduled` body (index.ts's `await enqueueDueMirrorSyncs
 *      (env, {})` + `await enqueueDuePushMirrorSyncs(env, {})`) is replaced
 *      with a single delegation:
 *        async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
 *          await handleScheduledCron(controller, env);
 *        },
 *   The dispatcher reproduces today's behavior on every non-hourly entry —
 *   the mirror producers run unconditionally, exactly as the current inline
 *   body does — and runs ONLY the (self-gated) demo producer on the hourly
 *   "0 * * * *" entry. The hourly entry is already in both wrangler configs
 *   (landed with this module), so wiring is the only remaining step.
 *   Tests exercise `handleScheduledCron` / `enqueueDueDemoSweeps` / the
 *   purge.ts consumer arm directly with fabricated ScheduledControllers —
 *   the delegation itself is one await.
 */

import { asc, eq, isNull, lt, or, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../db/schema";
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
 * NOT a site admin (`users.is_admin = false` — admin-owned repos are
 * exempt, and the demo's standing fixtures live under the bootstrap admin
 * precisely so they survive, §6.2) OR the row has a NULL owner (no
 * exempting principal exists → swept, fail-safe; every landed create path
 * populates ownerId, §3.1 step 2). Oldest first, LIMIT 50 — a backlog
 * (e.g. the §6.4 gate-flip backlog) drains oldest-first over hours.
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
    .select({ id: repositories.id })
    .from(repositories)
    .leftJoin(users, eq(repositories.ownerId, users.id))
    .where(and(lt(repositories.createdAt, cut), or(isNull(repositories.ownerId), eq(users.isAdmin, false))))
    .orderBy(asc(repositories.createdAt))
    .limit(limit);

  const messages: DemoSweepMessage[] = due.map((row) => ({ kind: "demo-sweep", repoId: row.id }));
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100).map((message) => ({ body: message })));
  }
  // EVERY sweep batch logs counts (§3.1 step 4) — including 0-eligible
  // ticks, whose compact one-liner proves the sweep ran. Gate-off ticks log
  // NOTHING (the early return above) — the default deployment's log stays
  // sweep-silent.
  console.log(`[demo-sweep] enqueued ${messages.length} of ${due.length} eligible (cut ${cut.toISOString()})`);
  return messages.length;
}

// ---------------------------------------------------------------------------
// The scheduled dispatch (§3.1) — see the HANDOFF NOTE in the module header
// ---------------------------------------------------------------------------

/**
 * The cron dispatcher (§3.1): the hourly entry carries ONLY the demo
 * producer (which self-gates on DEMO_MODE before its first D1 read — gate
 * off → the whole invocation performs zero reads and zero sends, §2's
 * invariant arm 1); every OTHER entry — the standing 10-minute step entry
 * and anything a future config adds — runs the mirror producers exactly as
 * the inline handler always has: unconditional, gate-independent (their CAS
 * guard absorbs any :00 overlap, sync.ts:890-898). The step entry therefore
 * NEVER triggers a sweep, in either gate state.
 */
export async function handleScheduledCron(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === DEMO_SWEEP_CRON) {
    await enqueueDueDemoSweeps(env, {});
    return;
  }
  // The mirror producers, exactly as today (index.ts scheduled) — the
  // pull-mirror SELECT+CAS+enqueue and the push-mirror twin.
  await enqueueDueMirrorSyncs(env, {});
  await enqueueDuePushMirrorSyncs(env, {});
}
