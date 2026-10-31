/**
 * The cron tick state's tests (usability F3): the arm census (the exact
 * handleScheduledCron dispatch mirror — four step arms on every non-hourly
 * entry, six producer arms on the hourly entry), the two tick upserts over
 * real D1 (success moves last_success + increments runs + CLEARS the error;
 * failure stamps the error pair and preserves the history; both clip; both
 * no-op on an empty arm set), and the monitor's read seam. The store module
 * is the whole write API — the scheduled handler's call sites are the thin
 * index.ts region (disclosed integration; no suite drives the entrypoint's
 * scheduled handler today).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { cronState } from "../db/schema";
import { DEMO_SWEEP_CRON } from "./demo-sweep";
import {
  CRON_ARMS,
  CRON_ERROR_MAX_CHARS,
  armsForEntry,
  clipCronError,
  listCronState,
  recordArmsFailure,
  recordArmsSuccess,
} from "./cron-state";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

// The tick rows persist across tests within the file (real local D1) — every
// test starts from the empty store (the census describes never touch D1).
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM cron_state").run();
});

const NOW = new Date("2026-10-30T09:00:00Z");
const LATER = new Date("2026-10-30T10:00:00Z");

const stepArms = armsForEntry("*/10 * * * *");
const hourlyArms = armsForEntry(DEMO_SWEEP_CRON);

describe("the arm census (CRON_ARMS — the handleScheduledCron dispatch mirror)", () => {
  it("lists exactly the ten landed arms with the two wrangler specs", () => {
    expect(CRON_ARMS.map((arm) => arm.arm)).toEqual([
      "update_mirrors",
      "update_push_mirrors",
      "stop_zombie_tasks",
      "stop_endless_tasks",
      "demo_sweep",
      "delete_old_audit_events",
      "cleanup_packages",
      "cleanup_actions",
      "cancel_abandoned_jobs",
      "cleanup_ephemeral_runners",
    ]);
    for (const arm of CRON_ARMS) {
      expect([DEMO_SWEEP_CRON, "*/10 * * * *"]).toContain(arm.spec);
    }
  });

  it("the step entry carries the four unconditional arms", () => {
    expect(stepArms.map((arm) => arm.arm)).toEqual([
      "update_mirrors",
      "update_push_mirrors",
      "stop_zombie_tasks",
      "stop_endless_tasks",
    ]);
  });

  it("the hourly entry carries the six producer arms", () => {
    expect(hourlyArms.map((arm) => arm.arm)).toEqual([
      "demo_sweep",
      "delete_old_audit_events",
      "cleanup_packages",
      "cleanup_actions",
      "cancel_abandoned_jobs",
      "cleanup_ephemeral_runners",
    ]);
  });

  it("EVERY other entry is a step entry (the dispatcher's unconditional else)", () => {
    // The hourly match is EXACT; a future config entry runs the step arms.
    expect(armsForEntry("5 * * * *").map((arm) => arm.arm)).toEqual(stepArms.map((arm) => arm.arm));
    expect(armsForEntry("* * * * *").map((arm) => arm.arm)).toEqual(stepArms.map((arm) => arm.arm));
  });
});

describe("recordArmsSuccess (the completed-tick upsert)", () => {
  it("inserts a fresh row (runs 1, last_success set) and increments on the next tick", async () => {
    await recordArmsSuccess(env.DB, hourlyArms, { now: NOW });
    let rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.runs === 1 && row.lastError === null && row.lastErrorUnix === null)).toBe(true);

    await recordArmsSuccess(env.DB, hourlyArms, { now: LATER });
    rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows.every((row) => row.runs === 2 && row.lastSuccessUnix !== null)).toBe(true);
    const byArm = await listCronState(env.DB);
    expect(byArm.get("demo_sweep")?.lastSuccess).toEqual(LATER);
  });

  it("a success CLEARS a recorded error (the error's answer)", async () => {
    await recordArmsFailure(env.DB, stepArms, new Error("DB/REPO_TASKS not bound"), { now: NOW });
    const failed = await listCronState(env.DB);
    expect(failed.get("update_mirrors")?.lastError).toBe("DB/REPO_TASKS not bound");

    await recordArmsSuccess(env.DB, stepArms, { now: LATER });
    const recovered = await listCronState(env.DB);
    expect(recovered.get("update_mirrors")?.lastError).toBeNull();
    expect(recovered.get("update_mirrors")?.lastErrorUnix).toBeNull();
    expect(recovered.get("update_mirrors")?.lastSuccess).toEqual(LATER);
    expect(recovered.get("update_mirrors")?.runs).toBe(1);
  });

  it("an empty arm set is a no-op (never invalid SQL)", async () => {
    await recordArmsSuccess(env.DB, [], { now: NOW });
    const rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows).toHaveLength(0);
  });
});

describe("recordArmsFailure (the entry stamp)", () => {
  it("inserts a fresh row preserving the never-succeeded posture (runs 0, no last_success)", async () => {
    await recordArmsFailure(env.DB, stepArms, new Error("the tick died"), { now: NOW });
    const state = await listCronState(env.DB);
    const row = state.get("stop_zombie_tasks")!;
    expect(row.lastError).toBe("the tick died");
    expect(row.lastErrorUnix).toEqual(NOW);
    expect(row.lastSuccess).toBeNull();
    expect(row.runs).toBe(0);
  });

  it("updates the error pair WITHOUT touching last_success/runs (the granularity note)", async () => {
    await recordArmsSuccess(env.DB, stepArms, { now: NOW });
    await recordArmsFailure(env.DB, stepArms, new Error("second tick threw"), { now: LATER });
    const state = await listCronState(env.DB);
    const row = state.get("update_push_mirrors")!;
    expect(row.lastSuccess).toEqual(NOW); // the earlier completed tick stands
    expect(row.runs).toBe(1);
    expect(row.lastError).toBe("second tick threw");
    expect(row.lastErrorUnix).toEqual(LATER);
  });

  it("stringifies non-Error rejections and clips past the bound with the visible marker", async () => {
    await recordArmsFailure(env.DB, [stepArms[0]!], "a plain string rejection", { now: NOW });
    expect((await listCronState(env.DB)).get("update_mirrors")?.lastError).toBe("a plain string rejection");

    const monster = "x".repeat(CRON_ERROR_MAX_CHARS + 50);
    await recordArmsFailure(env.DB, [stepArms[0]!], new Error(monster), { now: LATER });
    const stored = (await listCronState(env.DB)).get("update_mirrors")?.lastError;
    expect(stored).toHaveLength(CRON_ERROR_MAX_CHARS);
    expect(stored!.endsWith("…")).toBe(true);
  });

  it("an empty arm set is a no-op", async () => {
    await recordArmsFailure(env.DB, [], new Error("ignored"), { now: NOW });
    const rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows).toHaveLength(0);
  });
});

describe("clipCronError (the §5.2-style bound)", () => {
  it("passes short messages through unchanged", () => {
    expect(clipCronError("short")).toBe("short");
  });

  it("suffix-truncates to exactly the bound with the visible marker", () => {
    const clipped = clipCronError("y".repeat(CRON_ERROR_MAX_CHARS + 10));
    expect(clipped).toHaveLength(CRON_ERROR_MAX_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("listCronState (the monitor's read seam)", () => {
  it("an empty table answers an empty map — the never-fired arms render upstream's unset posture", async () => {
    const state = await listCronState(env.DB);
    expect(state.size).toBe(0);
  });
});
