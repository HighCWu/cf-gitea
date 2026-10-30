/**
 * The per-arm cron tick state (usability F3 —
 * docs/usability/findings-latency-health.md): the arm census, the cheap
 * per-entry tick upserts, and the monitor's read seam over the `cron_state`
 * D1 table (schema.ts, migration 0044).
 *
 * ## Why this exists
 *
 * Upstream keeps cron execution state IN MEMORY on its long-lived Task
 * structs (services/cron/tasks.go TaskTableRow: Prev/Next/Status/
 * LastMessage/ExecTimes — the admin cron page reads them live). A Workers
 * cron trigger fires a FRESH invocation per entry with no carry-over
 * memory, so the same columns land in D1: the Worker's `scheduled` handler
 * (src/index.ts) upserts one row per arm after each entry execution and the
 * admin monitor's cron page reads the rows — "did the crons run today"
 * becomes certifiable from the product surface instead of the Workers log.
 *
 * ## The arm census (CRON_ARMS)
 *
 * One entry per row of wrangler.jsonc.example `triggers.crons`; the arms
 * per entry mirror handleScheduledCron's dispatch EXACTLY
 * (services/demo-sweep.ts — the mount record in its module header):
 *
 *   - the hourly entry (`0 * * * *`, DEMO_SWEEP_CRON) carries FOUR producer
 *     arms: demo_sweep (SPEC-0014), delete_old_audit_events (SPEC-0015
 *     §4.3), cleanup_packages (SPEC-0016 §4.4) and cleanup_actions
 *     (SPEC-0012 §4.5);
 *   - EVERY OTHER entry (today the standing 10-minute step) carries the
 *     THREE unconditional arms: update_mirrors + update_push_mirrors
 *     (SPEC-0009 §2.6 / specs/push-mirror-outbound.md) and stop_zombie_tasks
 *     (SPEC-0012 §4.5/§5.6) — matching the dispatcher's unconditional else
 *     (a future config entry runs the step arms, never the hourly ones).
 *
 * Names are upstream's registered task name where a faithful twin exists at
 * the pin (tasks_basic.go:31 update_mirrors; tasks_actions.go:27
 * stop_zombie_tasks; tasks_basic.go:140 cleanup_packages; tasks_extended.go
 * :146 delete_old_audit_events; tasks_actions.go:70/:80 — our single
 * actions-retention producer carries the cleanup_actions +
 * cleanup_action_runs pair's bodies, folded per SPEC-0012 §4.5). Two arms
 * are cf-gitea extensions with no upstream task: demo_sweep (SPEC-0014)
 * and update_push_mirrors — upstream folds BOTH mirror families into the
 * ONE update_mirrors task (mirror.go:34-110 iterates pull and push mirrors
 * under one body); ours runs two producers, so the push twin gets the
 * convention-following name and the split is recorded here.
 *
 * Schedules render the WRANGLER EXPRESSION verbatim (the registries'
 * standing convention — the expression is literally what runs), not
 * upstream's `@every 10m` config strings.
 *
 * ## The recording granularity (entry-atomic, disclosed)
 *
 * The recorder sits in index.ts's `scheduled` handler AROUND the one
 * `handleScheduledCron` delegation (the dispatcher's own file is not the
 * recorder's owner), so per-PRODUCER attribution inside an entry is not
 * available. The honest consequence, both pinned here:
 *
 *   - a RESOLVED entry records success for every arm it carries — true for
 *     each arm (the dispatcher's swallowed probe failures are decisions the
 *     arms made, per the mission: a tick that ran and decided empty is a
 *     success), and
 *   - a REJECTED entry stamps `last_error` (+ `last_error_unix`) on every
 *     arm it carries WITHOUT touching last_success/runs — the entry is the
 *     platform's unit of scheduling/retry, the tick that carries these arms
 *     died before completing, and the monitor reads a fresh error against
 *     each arm's (possibly fresh-from-a-prior-tick) last success. Which
 *     producer threw is in the Workers log (the dispatcher's own
 *     console.error lines); the state records the entry truth.
 *
 * `recordArmsSuccess`/`recordArmsFailure` are ONE multi-row upsert per call
 * (sub-second, `ctx.waitUntil`-ridable) and never throw for empty arm sets.
 * A failed recording is the CALLER's log-and-continue (the tick's real work
 * already happened) — index.ts wraps both calls in a catch that logs.
 */

import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

import { cronState } from "../db/schema";
import { DEMO_SWEEP_CRON } from "./demo-sweep";

/** The standing 10-minute step entry (wrangler.jsonc.example triggers.crons
 *  — the update_mirrors cadence; sync.ts spells it out in comments for the
 *  same reason: a literal step expression in source, named constant here). */
export const STEP_ENTRY_CRON = "*/10 * * * *";

/** One registered scheduled arm: the registry name (the cron_state row key,
 *  the monitor row's op) and the wrangler entry that carries it. */
export interface CronArm {
  arm: string;
  spec: string;
}

/**
 * The landed arm census (the block comment holds the per-arm cites). Order:
 * the step entry's arms first, then the hourly entry's — the monitor renders
 * registry order. A scheduled arm added to handleScheduledCron joins THIS
 * table (and the monitor's listing through it) in the same change.
 */
export const CRON_ARMS: readonly CronArm[] = [
  // --- the step entry (EVERY non-hourly entry runs these three) -----------
  // upstream tasks_basic.go:31 (@every 10m) — the pull-mirror producer.
  { arm: "update_mirrors", spec: STEP_ENTRY_CRON },
  // The push-mirror producer — upstream's update_mirrors body covers BOTH
  // families (mirror.go:34-110); ours split them (push-mirror-outbound.md).
  { arm: "update_push_mirrors", spec: STEP_ENTRY_CRON },
  // upstream tasks_actions.go:27 (@every 5m) — rides the 10-minute step, the
  // standing cadence closest to upstream's (the dispatcher's own note).
  { arm: "stop_zombie_tasks", spec: STEP_ENTRY_CRON },
  // --- the hourly entry (DEMO_SWEEP_CRON ONLY) ----------------------------
  // SPEC-0014 §3.1 — the demo sweep producer; NO upstream task (the
  // sanctioned extension, self-gated on DEMO_MODE).
  { arm: "demo_sweep", spec: DEMO_SWEEP_CRON },
  // upstream tasks_extended.go:146 (@every 24h) — the audit-retention
  // producer (SPEC-0015 §4.3), self-gated on AUDIT_RETENTION_DAYS.
  { arm: "delete_old_audit_events", spec: DEMO_SWEEP_CRON },
  // upstream tasks_basic.go:140 (@midnight) — the packages-cleanup producer
  // (SPEC-0016 §4.4), probe-gated.
  { arm: "cleanup_packages", spec: DEMO_SWEEP_CRON },
  // upstream tasks_actions.go:70 + :80 (@midnight pair) — the
  // actions-retention producer carries BOTH bodies' role (artifact/log/run
  // retention, SPEC-0012 §4.5), self-gated on the ACTIONS_*_RETENTION_DAYS
  // trio; named for the pair's broader half.
  { arm: "cleanup_actions", spec: DEMO_SWEEP_CRON },
];

/** The entry's arms (the census filter — the hourly entry is matched EXACTLY
 *  on DEMO_SWEEP_CRON, everything else is a step entry for the dispatcher's
 *  unconditional else, so it carries the step arms). */
export function armsForEntry(cron: string): CronArm[] {
  const spec = cron === DEMO_SWEEP_CRON ? DEMO_SWEEP_CRON : STEP_ENTRY_CRON;
  return CRON_ARMS.filter((arm) => arm.spec === spec);
}

// ---------------------------------------------------------------------------
// The tick upserts (one multi-row statement per call)
// ---------------------------------------------------------------------------

/** The `last_error` emit bound — the system_notices §5.2 clip discipline at
 *  a smaller scale: an error one-liner plus its message fit comfortably, and
 *  the bound is defensive against multi-line library error payloads. */
export const CRON_ERROR_MAX_CHARS = 500;

/** The §5.2-style clip: keep the first `bound - 1` chars and append the
 *  visible `…` marker, so the stored length is exactly the bound when
 *  clipped. */
export function clipCronError(text: string, bound = CRON_ERROR_MAX_CHARS): string {
  if (text.length <= bound) return text;
  return text.slice(0, bound - 1) + "…";
}

/**
 * Record a COMPLETED tick for every arm of one entry: last_success_unix =
 * now, runs += 1, last_error/last_error_unix CLEARED (a success is the
 * error's answer). One multi-row upsert (`excluded` refs keep it a single
 * statement); an empty arm set is a no-op (an empty VALUES is invalid SQL
 * and no entry carries zero arms today — the guard is the cheap honesty).
 */
export async function recordArmsSuccess(
  db: D1Database,
  arms: readonly CronArm[],
  options: { now?: Date } = {},
): Promise<void> {
  if (arms.length === 0) return;
  const now = options.now ?? new Date();
  await drizzle(db)
    .insert(cronState)
    .values(arms.map((arm) => ({ arm: arm.arm, lastSuccessUnix: now, runs: 1 })))
    .onConflictDoUpdate({
      target: cronState.arm,
      set: {
        lastSuccessUnix: sql`excluded.last_success_unix`,
        runs: sql`${cronState.runs} + excluded.runs`,
        lastError: sql`excluded.last_error`,
        lastErrorUnix: sql`excluded.last_error_unix`,
      },
    });
}

/**
 * Stamp a FAILED entry on every arm it carries: last_error (clipped) +
 * last_error_unix = now; last_success_unix and runs are NEVER touched (the
 * arms that completed inside the failed entry keep their recorded history —
 * the granularity note in the module header). One multi-row upsert; an
 * empty arm set is a no-op.
 */
export async function recordArmsFailure(
  db: D1Database,
  arms: readonly CronArm[],
  error: unknown,
  options: { now?: Date } = {},
): Promise<void> {
  if (arms.length === 0) return;
  const now = options.now ?? new Date();
  const message = clipCronError(error instanceof Error ? error.message : String(error));
  await drizzle(db)
    .insert(cronState)
    .values(arms.map((arm) => ({ arm: arm.arm, lastError: message, lastErrorUnix: now })))
    .onConflictDoUpdate({
      target: cronState.arm,
      set: {
        lastError: sql`excluded.last_error`,
        lastErrorUnix: sql`excluded.last_error_unix`,
      },
    });
}

// ---------------------------------------------------------------------------
// The monitor's read seam (the admin cron page)
// ---------------------------------------------------------------------------

/** One arm's recorded state (the TaskTableRow triple, read back). */
export interface CronStateRow {
  arm: string;
  /** Last completed tick; null = never succeeded (upstream's zero time). */
  lastSuccess: Date | null;
  /** The last failed entry's clipped one-liner; null = clean. */
  lastError: string | null;
  /** When lastError was written; null = no recorded failure. */
  lastErrorUnix: Date | null;
  /** Completed ticks. */
  runs: number;
}

/**
 * The full tick state, keyed by arm name — ONE point scan of a ≤7-row table.
 * Arms without a row (nothing recorded yet — a fresh deployment, or the
 * golden harness) are simply absent: the monitor renders the never-fired
 * arms, exactly upstream's unset-Prev posture.
 */
export async function listCronState(db: D1Database): Promise<Map<string, CronStateRow>> {
  const rows = await drizzle(db).select().from(cronState).all();
  return new Map(
    rows.map((row) => [
      row.arm,
      {
        arm: row.arm,
        lastSuccess: row.lastSuccessUnix,
        lastError: row.lastError,
        lastErrorUnix: row.lastErrorUnix,
        runs: row.runs,
      },
    ]),
  );
}
