/**
 * The schedule registry suite (SPEC-0012 §D7): the robfig/cron v3 parser
 * port (grammar vectors, the @every phase delay, the TZ= zone), cronNext
 * against SpecSchedule.Next's field walks (month/day/hour jumps, the
 * dayMatches OR/AND rule, the five-year never-fire horizon, the DST gap and
 * fold materializations), withScheduleInEventPayload's merge arms, the
 * message guard, and the registry units over real local D1 (the registration
 * filter, the advance CAS winner/loser, the producer's due SELECT, the
 * delete sweep, the read port).
 *
 * The tree-side lifecycle (register on push / replace / remove) and the
 * consumer's run shape live in trigger.test.ts over the receive-pack harness.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { actionSchedules, actionScheduleSpecs } from "../../db/schema";
import { ACTIONS_USER_ID } from "./trigger";
import {
  advanceScheduleSpecCAS,
  cronNext,
  createScheduleTaskBySchedules,
  deleteScheduleTaskByRepo,
  dueScheduleSpecIds,
  getScheduleSpecById,
  getSchedulesByRepo,
  handleActionsScheduleTrigger,
  isActionsScheduleTriggerMessage,
  parseCronSpec,
  withScheduleInEventPayload,
  type ScheduleRegistryContext,
} from "./schedule";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = ["action_schedule_spec", "action_schedule"];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// The robfig/cron v3 parser (ParseStandard) + cronNext (SpecSchedule.Next)
// ---------------------------------------------------------------------------

describe("parseCronSpec (robfig standard)", () => {
  it("the grammar: fields, names, steps, ranges, leading zeros, descriptors", () => {
    expect(parseCronSpec("0 * * * *")).not.toBeNull();
    expect(parseCronSpec("15,45 * * * *")).not.toBeNull();
    expect(parseCronSpec("10-12 * * * *")).not.toBeNull();
    expect(parseCronSpec("*/15 * * * *")).not.toBeNull();
    expect(parseCronSpec("07 * * * *")).not.toBeNull();
    expect(parseCronSpec("0 0 ? * mon")).toMatchObject({ domStar: true, dowStar: false });
    expect(() => parseCronSpec("0 0 * * 7")).toThrow(); // robfig's dow range caps at 6
    expect(() => parseCronSpec("* * * *")).toThrow(); // 4 fields
    expect(() => parseCronSpec("60 * * * *")).toThrow(); // minute above max
    expect(() => parseCronSpec("0 0 30 2 *")).not.toThrow(); // parses; never fires (Feb 30)
    expect(() => parseCronSpec("")).toThrow();
    expect(() => parseCronSpec("@fortnightly")).toThrow(); // descriptors are exact (parser.go:365)
    expect(() => parseCronSpec("@HOURLY")).toThrow(); // the descriptor match is case-SENSITIVE
    expect(parseCronSpec("@hourly")).not.toBeNull();
  });

  it("@every carries the REAL phase delay now (Every()'s second truncation)", () => {
    expect(parseCronSpec("@every 30m")).toMatchObject({ every: true, everyDelaySeconds: 1800 });
    expect(parseCronSpec("@every 1h30m")).toMatchObject({ every: true, everyDelaySeconds: 5400 });
    expect(parseCronSpec("@every 90s")).toMatchObject({ every: true, everyDelaySeconds: 90 });
    expect(parseCronSpec("@every 500ms")).toMatchObject({ every: true, everyDelaySeconds: 0 }); // truncated to seconds
    expect(() => parseCronSpec("@every junk")).toThrow();
    expect(() => parseCronSpec("@every")).toThrow();
  });

  it("TZ= / CRON_TZ= prefixes set the zone; bad zones are parse errors (parser.go:84-92)", () => {
    expect(parseCronSpec("TZ=Asia/Tokyo 30 4 * * *")).toMatchObject({ zone: "Asia/Tokyo" });
    expect(parseCronSpec("CRON_TZ=America/New_York 30 4 * * *")).toMatchObject({ zone: "America/New_York" });
    expect(() => parseCronSpec("TZ=Mars/Olympus 30 4 * * *")).toThrow(/provided bad location Mars\/Olympus/);
    expect(parseCronSpec("30 4 * * *")).toMatchObject({ zone: undefined });
  });
});

describe("cronNext (robfig SpecSchedule.Next at minute granularity)", () => {
  /** The next occurrence of `spec` (a full spec string — TZ= prefixes ride
   *  inside it) strictly after `afterIso`. */
  const next = (spec: string, afterIso: string): number | null => cronNext(parseCronSpec(spec), sec(afterIso));

  it("the mission pair: '0 * * * *' from 13:00 lands 14:00; '0 12 * * *' from 13:00 lands tomorrow noon", () => {
    expect(next("0 * * * *", "2026-06-01T13:00:00Z")).toBe(sec("2026-06-01T14:00:00Z"));
    expect(next("0 * * * *", "2026-06-01T13:00:30Z")).toBe(sec("2026-06-01T14:00:00Z"));
    expect(next("0 12 * * *", "2026-06-01T13:00:00Z")).toBe(sec("2026-06-02T12:00:00Z"));
    expect(next("0 12 * * *", "2026-06-01T11:00:00Z")).toBe(sec("2026-06-01T12:00:00Z"));
  });

  it("minute sets and ranges land the FIRST matching minute (robfig's minute walk)", () => {
    expect(next("15,45 * * * *", "2026-06-01T10:00:00Z")).toBe(sec("2026-06-01T10:15:00Z"));
    expect(next("15,45 * * * *", "2026-06-01T10:16:00Z")).toBe(sec("2026-06-01T10:45:00Z"));
    expect(next("10-12 * * * *", "2026-06-01T10:13:00Z")).toBe(sec("2026-06-01T11:10:00Z"));
    expect(next("*/15 * * * *", "2026-06-01T10:16:00Z")).toBe(sec("2026-06-01T10:30:00Z"));
  });

  it("the dayMatches rule (spec.go:148-159): restricted dom+dow OR; a starred arm ANDs", () => {
    // June 2026: the 5th is a Friday, the 13th a Saturday.
    expect(next("0 0 13 * 5", "2026-06-01T00:00:00Z")).toBe(sec("2026-06-05T00:00:00Z")); // Friday the 5th (dow)
    expect(next("0 0 13 * 5", "2026-06-06T00:00:00Z")).toBe(sec("2026-06-12T00:00:00Z")); // the NEXT Friday (dow walks first)
    expect(next("0 0 13 * 6", "2026-06-07T00:00:00Z")).toBe(sec("2026-06-13T00:00:00Z")); // the 13th (dom, a Saturday)
    expect(next("0 0 1 * *", "2026-05-31T00:00:00Z")).toBe(sec("2026-06-01T00:00:00Z")); // starred dow ANDs dom 1
    expect(next("0 0 1 * *", "2026-06-02T00:00:00Z")).toBe(sec("2026-07-01T00:00:00Z"));
  });

  it("month jumps and the five-year never-fire horizon", () => {
    expect(next("0 0 1 1 *", "2026-06-01T00:00:00Z")).toBe(sec("2027-01-01T00:00:00Z"));
    expect(next("0 0 1 jan *", "2026-01-02T00:00:00Z")).toBe(sec("2027-01-01T00:00:00Z"));
    // "0 0 30 2 *" — schedule.go:110's own never-occurring example.
    expect(next("0 0 30 2 *", "2026-02-01T00:00:00Z")).toBeNull();
  });

  it("@every anchors the phase: Next(after) = after + the parsed delay (ConstantDelaySchedule.Next)", () => {
    expect(next("@every 30m", "2026-06-01T10:07:00Z")).toBe(sec("2026-06-01T10:37:00Z"));
    expect(next("@every 12h", "2026-06-01T00:00:00Z")).toBe(sec("2026-06-01T12:00:00Z"));
  });

  it("TZ= zones match fields in WALL time (schedule_spec.go:36-39 keeps the parsed location)", () => {
    // 2026-06-01T00:00Z = 09:00 JST; the next 04:30 JST is 2026-06-02
    // 04:30 JST = 2026-06-01T19:30Z.
    expect(next("TZ=Asia/Tokyo 30 4 * * *", "2026-06-01T00:00:00Z")).toBe(sec("2026-06-01T19:30:00Z"));
    // Already past 04:30 JST today (20:30 JST) → the same next wall minute.
    expect(next("TZ=Asia/Tokyo 30 4 * * *", "2026-06-01T11:30:00Z")).toBe(sec("2026-06-01T19:30:00Z"));
    // UTC specs stay UTC: the same field set without the prefix from 00:00Z.
    expect(next("30 4 * * *", "2026-06-01T00:00:00Z")).toBe(sec("2026-06-01T04:30:00Z"));
  });

  it("DST gap: a nonexistent wall time rounds UP through the transition at the same wall minute (robfig's instant stepping)", () => {
    // America/New_York, 2026-03-08: 02:00 EST → 03:00 EDT (07:00Z). The
    // minute loop crosses the gap as INSTANTS — wall minute 30 next occurs
    // at 03:30 EDT = 07:30Z (robfig's minute-walk behavior; the naive
    // wall-to-epoch mapping of 02:30 EST would be 07:30Z, and the gap arm
    // lands on the same instant here).
    expect(next("TZ=America/New_York 30 2 * * *", "2026-03-08T00:00:00Z")).toBe(sec("2026-03-08T07:30:00Z"));
    // The contrast day (no transition, already EDT): 02:30 EDT = 06:30Z.
    expect(next("TZ=America/New_York 30 2 * * *", "2026-03-09T00:00:00Z")).toBe(sec("2026-03-09T06:30:00Z"));
  });

  it("DST fold: a doubled wall time takes the EARLIER occurrence (robfig's first match)", () => {
    // America/New_York, 2026-11-01: 02:00 EDT → 01:00 EST (06:00Z); wall
    // 01:30 occurs twice (05:30Z EDT, 06:30Z EST). robfig's walk returns
    // the first.
    expect(next("TZ=America/New_York 30 1 * * *", "2026-11-01T00:00:00Z")).toBe(sec("2026-11-01T05:30:00Z"));
    // The §D7 micro-divergence arm: the wall walk is naive (1:59 → 2:00),
    // so from inside the fold's first pass the NEXT match is tomorrow's
    // single occurrence (Nov 2 is EST: 01:30 = 06:30Z) — robfig would fire
    // the doubled second pass (06:30Z Nov 1); we fire once per day.
    expect(next("TZ=America/New_York 30 1 * * *", "2026-11-01T05:31:00Z")).toBe(sec("2026-11-02T06:30:00Z"));
  });
});

// ---------------------------------------------------------------------------
// The payload merge + message guard
// ---------------------------------------------------------------------------

describe("withScheduleInEventPayload (schedule_tasks.go:169-206)", () => {
  it("merges the schedule key into the registration payload", () => {
    const merged = withScheduleInEventPayload(JSON.stringify({ ref: "refs/heads/main", head_commit: { id: "abc" } }), "0 * * * *");
    const parsed = JSON.parse(merged) as { schedule?: string; ref?: string };
    expect(parsed.schedule).toBe("0 * * * *");
    expect(parsed.ref).toBe("refs/heads/main");
  });

  it("the nil/empty/junk stored payloads start from a fresh map and still set the key (:181-186)", () => {
    expect(JSON.parse(withScheduleInEventPayload("null", "0 12 * * *"))).toEqual({ schedule: "0 12 * * *" });
    expect(JSON.parse(withScheduleInEventPayload("", "0 12 * * *"))).toEqual({ schedule: "0 12 * * *" });
    expect(JSON.parse(withScheduleInEventPayload("not-json{", "0 12 * * *"))).toEqual({ schedule: "0 12 * * *" });
    expect(JSON.parse(withScheduleInEventPayload("[1,2]", "0 12 * * *"))).toEqual({ schedule: "0 12 * * *" });
  });

  it("an empty spec leaves the payload verbatim (withScheduleInEventPayload's early return)", () => {
    expect(withScheduleInEventPayload('{"a":1}', "")).toBe('{"a":1}');
  });
});

describe("the message guard narrows the producer's shape", () => {
  it("accepts {kind, specId} and nothing else", () => {
    expect(isActionsScheduleTriggerMessage({ kind: "actions-trigger", specId: 7 })).toBe(true);
    expect(isActionsScheduleTriggerMessage({ kind: "demo-sweep", repoId: "r1" })).toBe(false);
    expect(isActionsScheduleTriggerMessage({ kind: "actions-trigger", repoId: "r1", scheduledUnix: 5 })).toBe(false);
    expect(isActionsScheduleTriggerMessage({ kind: "actions-trigger" })).toBe(false);
    expect(isActionsScheduleTriggerMessage(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The registry units over real D1
// ---------------------------------------------------------------------------

const BASE_CTX: ScheduleRegistryContext = {
  repoId: "repo-sched-unit",
  ownerId: 41,
  ref: "refs/heads/main",
  commitSha: "a".repeat(40),
  commitTitle: "ci: schedule workflows",
  event: "push",
  eventPayload: JSON.stringify({ ref: "refs/heads/main" }),
};

describe("createScheduleTaskBySchedules (schedule.go:42-79)", () => {
  it("one schedule row per workflow; unparsable and never-occurring specs register no spec row", async () => {
    const created = await createScheduleTaskBySchedules(env.DB, BASE_CTX, [
      { entryName: "hourly.yml", content: "on:\n  schedule:\n    - cron: '0 * * * *'\n", specs: ["0 * * * *"] },
      { entryName: "broken.yml", content: "on:\n  schedule:\n    - cron: '99 * * * *'\n", specs: ["99 * * * *"] },
      { entryName: "never.yml", content: "on:\n  schedule:\n    - cron: '0 0 30 2 *'\n", specs: ["0 0 30 2 *"] },
      { entryName: "impossible.yml", content: "on:\n  schedule:\n    - cron: '@nope'\n", specs: ["@nope"] },
    ]);
    expect(created).toBe(4);
    const schedules = await db().select().from(actionSchedules).where(eq(actionSchedules.repoId, BASE_CTX.repoId));
    expect(schedules).toHaveLength(4);
    // The registration stamps (notifier_helper.go:632-644).
    const hourly = schedules.find((s) => s.workflowId === "hourly.yml")!;
    expect(hourly.title).toBe("ci: schedule workflows");
    expect(hourly.triggerUserId).toBe(ACTIONS_USER_ID);
    expect(hourly.event).toBe("push");
    expect(hourly.commitSha).toBe(BASE_CTX.commitSha);
    expect(JSON.parse(hourly.specs)).toEqual(["0 * * * *"]);
    // Exactly ONE spec row survived the filter.
    const specs = await db().select().from(actionScheduleSpecs);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.spec).toBe("0 * * * *");
    expect(specs[0]?.scheduleId).toBe(hourly.id);
    expect(specs[0]?.next).not.toBeNull();
    expect(specs[0]?.prev).toBeNull();
  });

  it("empty detection creates nothing (the len(rows) == 0 early return, schedule.go:44-46)", async () => {
    expect(await createScheduleTaskBySchedules(env.DB, BASE_CTX, [])).toBe(0);
    expect(await db().select().from(actionSchedules)).toHaveLength(0);
  });
});

describe("advanceScheduleSpecCAS (UpdateScheduleSpec + the §D7 CAS)", () => {
  it("the winner's WHERE matches; the second delivery (stale prev/next) loses with 0 rows", async () => {
    await createScheduleTaskBySchedules(env.DB, BASE_CTX, [
      { entryName: "hourly.yml", content: "on:\n  schedule:\n    - cron: '0 * * * *'\n", specs: ["0 * * * *"] },
    ]);
    const spec = (await db().select().from(actionScheduleSpecs))[0]!;
    const oldNext = spec.next!.getTime() / 1000;
    const newNext = oldNext + 3600;

    // The winner reads the same row state.
    expect(await advanceScheduleSpecCAS(env.DB, spec, newNext)).toBe(true);
    const afterWin = (await db().select().from(actionScheduleSpecs).where(eq(actionScheduleSpecs.id, spec.id)))[0]!;
    expect(afterWin.prev!.getTime() / 1000).toBe(oldNext);
    expect(afterWin.next!.getTime() / 1000).toBe(newNext);

    // The concurrent delivery still holds the ORIGINAL row read — its WHERE
    // (prev = NULL, next = old) no longer matches.
    expect(await advanceScheduleSpecCAS(env.DB, spec, newNext + 3600)).toBe(false);
    const afterLoss = (await db().select().from(actionScheduleSpecs).where(eq(actionScheduleSpecs.id, spec.id)))[0]!;
    expect(afterLoss.next!.getTime() / 1000).toBe(newNext); // unchanged
  });
});

describe("dueScheduleSpecIds (startTasks' iterate predicate)", () => {
  it("selects next <= now; NULL and future rows drop out", async () => {
    const now = sec("2026-06-01T10:00:00Z");
    const created = await createScheduleTaskBySchedules(env.DB, BASE_CTX, [
      { entryName: "a.yml", content: "x", specs: ["0 * * * *"] },
    ]);
    const scheduleId = (await db().select().from(actionSchedules).where(eq(actionSchedules.repoId, BASE_CTX.repoId)))[0]!.id;
    expect(created).toBe(1);
    const rows = await db()
      .insert(actionScheduleSpecs)
      .values([
        { repoId: BASE_CTX.repoId, scheduleId, spec: "0 0 * * *", next: new Date(now * 1000), prev: null, created: new Date(), updated: new Date() },
        { repoId: BASE_CTX.repoId, scheduleId, spec: "0 1 * * *", next: new Date((now + 3600) * 1000), prev: null, created: new Date(), updated: new Date() }, // future
        { repoId: BASE_CTX.repoId, scheduleId, spec: "@parked", next: null, prev: null, created: new Date(), updated: new Date() }, // never-scheduled
      ])
      .returning({ id: actionScheduleSpecs.id, spec: actionScheduleSpecs.spec });
    const dueId = rows.find((r) => r.spec === "0 0 * * *")!.id;
    expect(await dueScheduleSpecIds(env.DB, now)).toEqual([dueId]);
    // The future row joins once due; the NULL row stays excluded forever.
    const later = await dueScheduleSpecIds(env.DB, now + 7200);
    expect(later).toHaveLength(2);
    expect(later).toContain(dueId);
  });
});

describe("deleteScheduleTaskByRepo + getSchedulesByRepo + the consumer's gone-row arms", () => {
  it("the delete sweeps both tables; the read port orders id DESC; a gone spec is a silent no-op", async () => {
    await createScheduleTaskBySchedules(env.DB, BASE_CTX, [
      { entryName: "a.yml", content: "x", specs: ["0 * * * *"] },
      { entryName: "b.yml", content: "x", specs: ["30 * * * *"] },
    ]);
    const listed = await getSchedulesByRepo(env.DB, BASE_CTX.repoId);
    expect(listed.map((s) => s.workflowId)).toEqual(["b.yml", "a.yml"]); // id DESC (schedule_list.go:32-34)
    expect((await getSchedulesByRepo(env.DB, "repo-other"))).toHaveLength(0);

    const spec = (await db().select().from(actionScheduleSpecs))[0]!;
    // Deleting the repo's rows strands the message's spec id — the consumer
    // loads it by id and skips (schedule_tasks.go:74-78's gone-row shape).
    await deleteScheduleTaskByRepo(env.DB, BASE_CTX.repoId);
    expect(await db().select().from(actionSchedules)).toHaveLength(0);
    expect(await db().select().from(actionScheduleSpecs)).toHaveLength(0);
    expect(await getScheduleSpecById(env.DB, spec.id)).toBeNull();
    expect(await handleActionsScheduleTrigger({ d1: env.DB, appUrl: "" }, { kind: "actions-trigger", specId: spec.id })).toBe(0);
  });
});
