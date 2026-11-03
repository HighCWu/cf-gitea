/**
 * The scheduled-workflow registry — upstream's TWO-TABLE design
 * (SPEC-0012 §D7, the 2026-11-03 user-ruled alignment that replaced W14's
 * stateless tick-window design). Ported from the pin fc4936884584a41931906553d96c2601d750e6ef:
 *
 *   - models/actions/schedule.go — the ActionSchedule row +
 *     CreateScheduleTaskBySchedules (:45-88, insert schedule rows + one spec
 *     row per parseable ever-occurring spec) + DeleteScheduleTaskByRepo
 *     (:90-102) + CleanRepoScheduleTasks' delete half;
 *   - models/actions/schedule_list.go — FindScheduleOptions
 *     (getSchedulesByRepo's read port);
 *   - models/actions/schedule_spec.go — ActionScheduleSpec + Parse()
 *     (:34-46, robfig/cron v3 with the UTC default, `schedule_spec.go:22-45`)
 *     + UpdateScheduleSpec (:48-54);
 *   - services/actions/schedule_tasks.go — the ticker half: startTasks
 *     (:31-59, `WHERE next > 0 AND next <= now`, one failing spec never
 *     aborts the pass), startTask (:62-110, ADVANCE PREV/NEXT FIRST —
 *     "a failed update cannot duplicate the run", :61 — then the schedule/
 *     repo/archived/unit/disabled skips), CreateScheduleTaskBySpec
 *     (:113-166, the run's verbatim fields) and withScheduleInEventPayload
 *     (:169-206);
 *   - services/actions/notifier_helper.go — handleSchedules' registry
 *     replace (:586-649: default-branch only, count → delete → re-insert
 *     from the tree, rows stamped with the Actions user + the push payload).
 *
 * The tree-reading half of DetectAndHandleSchedules (notifier_helper.go:654-685)
 * lives in trigger.ts, which owns the workflow enumeration; the registry
 * writes and the ticker live HERE. The module boundary mirrors upstream's
 * models/services split (schedule.ts imports only the run-insert port from
 * trigger.ts; trigger.ts imports the registry writer from here — a
 * function-body-only cycle, the update.ts precedent).
 *
 * ## The recorded divergences (each SPEC §D7; nothing else deviates)
 *
 *   - IDs: upstream int64 repo ids → TEXT repositories.id; owner/user ids
 *     stay INTEGER (users.id).
 *   - Cadence floor: upstream's `start_schedule_tasks` runs @every 1m
 *     (cron/tasks_actions.go:59); ours rides the standing 10-minute step
 *     entry (the every-ten-minutes cron, Workers cron floor, 30 s CPU
 *     budget — the producer is one indexed SELECT + chunked sendBatch).
 *     Minute-resolution specs fire at most once
 *     per scan; this REPLACES W14's recorded 60 m floor. A 1-minute entry
 *     is a future
 *     config knob.
 *   - The CAS: upstream's ticker is process-exclusive, so
 *     UpdateScheduleSpec's plain prev/next UPDATE is just bookkeeping. Our
 *     consumers are queue deliveries — the advance UPDATE carries the read
 *     prev/next in its WHERE (an optimistic CAS): changes=1 wins and
 *     inserts the run, 0 rows changed loses and skips. The racy
 *     `json_extract(event_payload,'$.schedule_unix')` check-then-insert
 *     probe is RETIRED with it (upstream has no payload dedupe key).
 *   - TZ=/CRON_TZ= specs honor their zone through workerd's Intl timezone
 *     data (upstream Parse keeps the parsed location, schedule_spec.go:36-39;
 *     no-prefix specs are forced UTC exactly upstream). DST gaps round up
 *     through the transition (robfig's instant-stepping); DST folds take the
 *     EARLIER occurrence — robfig's wall-walk fires a folded hour twice, we
 *     fire it once (the §D7 micro-divergence).
 *   - Consume-side `now`: startTask's `now` is the ticker's clock; ours is
 *     the delivery's (the advance and its `Next(now+1m)` evaluate at consume
 *     time; the producer's tick only selects due rows).
 *   - The settings-change arm (services/repository/setting.go:20-64 —
 *     UpdateRepositoryUnits fires DeleteScheduleTaskByRepo +
 *     DetectAndHandleSchedules on every actions-unit write and
 *     CleanRepoScheduleTasks on the disable) and CleanRepoScheduleTasks
 *     (services/actions/clear_tasks.go:59-63, the notify wrapper over
 *     models/actions/schedule.go:104-123) are WIRED:
 *     the settings arm rides saveRepoSettings' has_actions write
 *     (api/services/repo-settings.ts) and the archive seam
 *     (setRepoArchived), and the clean rides the hourly
 *     clean_repo_schedule_tasks producer (services/demo-sweep.ts — the
 *     clean_repo_schedule_tasks census arm, the residual-row sweep that
 *     covers the seams our surface lacks, upstream's own "app.ini will be
 *     changed manually" posture, notifier_helper.go:156-160).
 *   - SwitchSchedulesToDefaultBranch (services/actions/clear_tasks.go:65-77)
 *     is WIRED (the 2026-11-03 follow-up): the default-branch-change
 *     cleanup — delete the registry rows, cancel the live schedule runs on
 *     the OLD default's ref, then the actions-unit-gated re-register from
 *     the NEW default through the standalone detectAndHandleSchedules
 *     (the same newNotifyInputForSchedules registration, :82-85). Its three
 *     upstream callers map to our three default-branch writers: the API
 *     PATCH's default_branch arm (routes/repo.ts — repo.go:733), the web
 *     settings write (branch-protection.tsx applyDefaultBranchForm —
 *     SetRepoDefaultBranch, branch.go:729) and the default-branch RENAME
 *     (ui/index.ts branchRenameSubmit — RenameBranch, branch.go:489).
 */

import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { findRepositoryById, type RepositoryRow } from "../../api/services/repository";
import { engineName } from "../../repos/service";
import {
  actionRunJobs,
  actionRuns,
  actionScheduleSpecs,
  actionSchedules,
  repositories,
  repoUnits,
} from "../../db/schema";
import { loadRepoActionsConfig } from "./config";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_WAITING,
  ellipsisDisplayString,
  increaseTaskVersion,
} from "./model";
import { hasWaitingJobsToPick, isDoneStatus, refreshRunStatus, stopTask } from "./update";
import {
  ACTIONS_USER_ID,
  getEventsFromContent,
  insertTriggeredRunSplit,
  listWorkflows,
  type ActionsTriggerEnv,
  type TriggerCellReads,
} from "./trigger";

// ---------------------------------------------------------------------------
// The robfig/cron v3 grammar (models/actions/schedule_spec.go Parse +
// parser.go/spec.go — the W14 parser carried forward with the two pieces the
// stateless design could discard: the @every delay as REAL phase state and
// the TZ= zone).
// ---------------------------------------------------------------------------

/**
 * A parsed spec — SpecSchedule's five field sets plus the two star flags the
 * dayMatches OR rule reads (parser.go:284-296: a STARRED (unstepped
 * star-or-question-mark) dom or dow ANDs both fields; two restricted fields
 * OR — and a stepped star clears the star bit, "if step greater than 1,
 * extra = 0"). `every` carries the `@every <duration>` form
 * (ConstantDelaySchedule, parser.go:430-437 → Every(), constantdelay.go:14-22:
 * the delay truncates to whole seconds) — its DELAY is load-bearing phase
 * state now (the spec row's next anchors it). `zone` is the TZ=/CRON_TZ=
 * location (undefined = the forced UTC default, schedule_spec.go:41-45).
 */
export interface CronSchedule {
  every: boolean;
  /** The `@every` delay in seconds (0 unless `every`). */
  everyDelaySeconds: number;
  minute: boolean[]; // 0-59
  hour: boolean[]; // 0-23
  dom: boolean[]; // 1-31
  domStar: boolean;
  month: boolean[]; // 1-12
  dow: boolean[]; // 0-6 (0 = Sunday — JS getUTCDay's own base)
  dowStar: boolean;
  /** The IANA zone the fields match in; undefined = UTC. */
  zone?: string;
}

/** The robfig month/dow name tables (parser.go's monthChars/dowChars — the
 *  three-letter, lowercase forms ParseStandard accepts; names match
 *  case-insensitively, parseIntOrName:322-328). */
const CRON_MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CRON_DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** The descriptor table (robfig descriptors.go), normalized to the five-field
 *  form (upstream's six-field constants lead with the seconds 0). */
const CRON_DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseIntOrName(token: string, names: Record<string, number> | undefined): number {
  if (names !== undefined) {
    // robfig's lookup is CASE-INSENSITIVE (parser.go's parseIntOrName reads
    // names[strings.ToLower(expr)]) — "MON", "Jan" and "sun" all parse; the
    // lowercase table above is matched against the LOWERCASED token.
    const named = names[token.toLowerCase()];
    if (named !== undefined) return named;
  }
  // strconv.Atoi's decimal arm: leading zeros parse ("07" = 7)
  if (!/^\d+$/.test(token)) {
    throw new Error(`failed to parse int or name ${token}`);
  }
  return Number(token);
}

/** getField (parser.go:243-258): the comma-list split, each part through
 *  getRange, the bit sets OR'd (a star part keeps the star flag). */
function parseCronField(field: string, min: number, max: number, names: Record<string, number> | undefined, bits: boolean[]): boolean {
  let star = false;
  for (const expr of field.split(",")) {
    if (parseCronRange(expr, min, max, names, bits)) star = true;
  }
  return star;
}

/** getRange (parser.go:260-322) over a boolean set — the errors verbatim. */
function parseCronRange(expr: string, min: number, max: number, names: Record<string, number> | undefined, bits: boolean[]): boolean {
  const rangeAndStep = expr.split("/");
  if (rangeAndStep.length > 2) throw new Error(`too many slashes: ${expr}`);
  const lowAndHigh = rangeAndStep[0]!.split("-");
  if (lowAndHigh.length > 2) throw new Error(`too many hyphens: ${expr}`);
  const singleDigit = lowAndHigh.length === 1;
  let star = false;
  let start: number;
  let end: number;
  if (lowAndHigh[0] === "*" || lowAndHigh[0] === "?") {
    start = min;
    end = max;
    star = true;
  } else {
    start = parseIntOrName(lowAndHigh[0]!, names);
    switch (lowAndHigh.length) {
      case 1:
        end = start;
        break;
      case 2:
        end = parseIntOrName(lowAndHigh[1]!, names);
        break;
      default:
        throw new Error(`too many hyphens: ${expr}`);
    }
  }
  let step = 1;
  if (rangeAndStep.length === 2) {
    if (!/^\d+$/.test(rangeAndStep[1]!)) throw new Error(`failed to parse int: ${rangeAndStep[1]}`);
    step = Number(rangeAndStep[1]);
    // Special handling: "N/step" means "N-max/step".
    if (singleDigit) end = max;
    if (step > 1) star = false; // the starBit clear
  }
  if (start < min) throw new Error(`beginning of range (${start}) below minimum (${min}): ${expr}`);
  if (end > max) throw new Error(`end of range (${end}) above maximum (${max}): ${expr}`);
  if (start > end) throw new Error(`beginning of range (${start}) beyond end of range (${end}): ${expr}`);
  if (step <= 0) throw new Error(`step of range should be a positive number: ${expr}`);
  for (let v = start; v <= end; v += step) bits[v] = true;
  return star;
}

/** time.ParseDuration's simple forms for the `@every` delay (parser.go:433's
 *  ParseDuration): sign, decimal value, compound units (ns us µs ms s m h).
 *  Every() truncates the result to whole seconds (constantdelay.go:17-21). */
function parseDurationSeconds(raw: string): number {
  let rest = raw;
  let sign = 1;
  if (rest.startsWith("-")) {
    sign = -1;
    rest = rest.slice(1);
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1);
  }
  if (rest === "") throw new Error(`time: invalid duration "${raw}"`);
  const units: Array<[string, number]> = [
    ["ns", 1e-9],
    ["us", 1e-6],
    ["µs", 1e-6],
    ["ms", 1e-3],
    ["s", 1],
    ["m", 60],
    ["h", 3600],
  ];
  let total = 0;
  while (rest.length > 0) {
    const match = /^(\d+(?:\.\d*)?)/.exec(rest);
    if (match === null) throw new Error(`time: invalid duration "${raw}"`);
    const value = Number(match[1]!);
    rest = rest.slice(match[1]!.length);
    const unit = units.find(([u]) => rest.startsWith(u));
    if (unit === undefined) {
      throw new Error(`time: unknown unit "${rest[0] ?? ""}" in duration "${raw}"`);
    }
    rest = rest.slice(unit[0].length);
    total += value * unit[1];
  }
  return Math.trunc(sign * total);
}

/** robfig parser.go:84-92's TZ extraction: the prefix, the first space, the
 *  name between; a bad zone is a parse error ("provided bad location").
 *  workerd carries the ICU tzdata, so Intl validates the IANA name. */
function extractZone(spec: string): { zone: string; rest: string } {
  const spaceAt = spec.indexOf(" ");
  const eqAt = spec.indexOf("=");
  const name = spec.slice(eqAt + 1, spaceAt === -1 ? spec.length : spaceAt);
  try {
    // The validation probe (time.LoadLocation's arm): an unknown zone throws.
    new Intl.DateTimeFormat("en-US", { timeZone: name, hour12: false });
  } catch {
    throw new Error(`provided bad location ${name}`);
  }
  return { zone: name, rest: spaceAt === -1 ? "" : spec.slice(spaceAt).trim() };
}

/**
 * cron.ParseStandard (robfig/cron v3 parser.go:84-146): the TZ prefix, the
 * descriptor forms, else exactly five whitespace-separated fields (minute
 * hour dom month dow — ParseStandard carries no seconds field), each through
 * getRange. A parse failure THROWS — the registry skips the spec at
 * insert-time (schedule.go:63-66) and the consumer skips without advancing
 * (the same observable as upstream's per-occurrence error log).
 */
export function parseCronSpec(raw: string): CronSchedule {
  if (raw.trim() === "") throw new Error("empty spec string");
  let zone: string | undefined;
  let spec = raw.trim();
  // The TZ= / CRON_TZ= prefix (parser.go:84-92) — the REST of the spec is
  // matched in that zone; without a prefix Parse() forces UTC
  // (schedule_spec.go:41-45).
  if (spec.startsWith("TZ=") || spec.startsWith("CRON_TZ=")) {
    const extracted = extractZone(spec);
    zone = extracted.zone;
    spec = extracted.rest;
  }
  if (spec.startsWith("@")) {
    const schedule: CronSchedule = {
      every: false,
      everyDelaySeconds: 0,
      minute: new Array<boolean>(60).fill(false),
      hour: new Array<boolean>(24).fill(false),
      dom: new Array<boolean>(32).fill(false),
      domStar: false,
      month: new Array<boolean>(13).fill(false),
      dow: new Array<boolean>(7).fill(false),
      dowStar: false,
      zone,
    };
    // Descriptors are case-SENSITIVE (parser.go:365's exact switch); the
    // @every prefix likewise (:429).
    if (spec.startsWith("@every ")) {
      schedule.every = true;
      schedule.everyDelaySeconds = parseDurationSeconds(spec.slice("@every ".length));
      return schedule;
    }
    const mapped = CRON_DESCRIPTORS[spec];
    if (mapped === undefined) throw new Error(`unrecognized descriptor: ${spec}`);
    return parseCronSpec(mapped);
  }
  const fields = spec.split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected exactly 5 fields, found ${fields.length}: ${raw}`);
  const schedule: CronSchedule = {
    every: false,
    everyDelaySeconds: 0,
    minute: new Array<boolean>(60).fill(false),
    hour: new Array<boolean>(24).fill(false),
    dom: new Array<boolean>(32).fill(false),
    domStar: false,
    month: new Array<boolean>(13).fill(false),
    dow: new Array<boolean>(7).fill(false),
    dowStar: false,
    zone,
  };
  parseCronField(fields[0]!, 0, 59, undefined, schedule.minute);
  parseCronField(fields[1]!, 0, 23, undefined, schedule.hour);
  schedule.domStar = parseCronField(fields[2]!, 1, 31, undefined, schedule.dom);
  parseCronField(fields[3]!, 1, 12, CRON_MONTH_NAMES, schedule.month);
  schedule.dowStar = parseCronField(fields[4]!, 0, 6, CRON_DOW_NAMES, schedule.dow);
  return schedule;
}

/** dayMatches (spec.go:148-159) over one wall day: restricted dom+dow OR; a
 *  starred arm ANDs. */
function cronDayMatches(s: CronSchedule, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = s.dom[dayOfMonth] === true;
  const dowMatch = s.dow[dayOfWeek] === true;
  if (s.domStar || s.dowStar) return domMatch && dowMatch;
  return domMatch || dowMatch;
}

/** The UTC offset (seconds) of `zone` at the given instant. */
function zoneOffsetSeconds(zone: string, epochSeconds: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) / 1000;
  return Math.round(asUTC - epochSeconds);
}

/**
 * robfig's Next (spec.go:44-146 + constantdelay.go:26-29) at the minute
 * granularity the standard grammar constrains (the seconds field is the
 * parser's implicit 0, so Next lands on minute boundaries strictly after the
 * given instant): the ConstantDelay arm adds the phase delay verbatim
 * (startTask's +1m look-ahead is the CALLER's, schedule_tasks.go:69), the
 * SpecSchedule arm jumps month → day → hour → minute in wall-calendar order
 * with the five-year horizon (spec.go:58-60). Returns the epoch second, or
 * null for the never-occurring spec ("0 0 30 2 *" — upstream's own example,
 * schedule.go:69-71). UTC specs (the forced default) skip the zone
 * materialization entirely.
 */
export function cronNext(s: CronSchedule, afterUnixSeconds: number): number | null {
  if (s.every) {
    // ConstantDelaySchedule.Next(after) = after.Add(delay) (the sub-second
    // part was truncated at parse, constantdelay.go:26-29).
    return Math.floor(afterUnixSeconds) + s.everyDelaySeconds;
  }

  // The wall-minute search space: UTC specs iterate true epoch minutes; a
  // zoned spec iterates WALL minutes expressed as pseudo-epoch (wall-as-UTC),
  // materialized back through the zone at the end.
  const wallStart =
    s.zone === undefined ? Math.floor(afterUnixSeconds / 60) : wallPseudoMinute(s.zone, afterUnixSeconds);
  let candidate = wallStart + 1;
  // The five-year horizon (spec.go:58-60: yearLimit = t.Year() + 5).
  const capMinutes = wallStart + 5 * 366 * 24 * 60;

  while (candidate <= capMinutes) {
    const fields = wallFieldsOf(candidate);
    const { year, month, day, hour, minute } = fields;
    // month[] is 1-based (the parse table) over getUTCMonth's 0-based read.
    if (s.month[month + 1] !== true) {
      // Jump to the first minute of the next month (spec.go:65-77's month
      // loop); the year wrap is the cap's business.
      candidate = minuteOfWall(year, month + 1, 1, 0, 0);
      continue;
    }
    if (!cronDayMatches(s, day, dowOfWall(year, month, day))) {
      candidate = minuteOfWall(year, month, day + 1, 0, 0);
      continue;
    }
    if (s.hour[hour] !== true) {
      candidate = minuteOfWall(year, month, day, hour + 1, 0);
      continue;
    }
    if (s.minute[minute] !== true) {
      candidate += 1;
      continue;
    }
    return s.zone === undefined ? candidate * 60 : materializeWall(s.zone, afterUnixSeconds, candidate);
  }
  return null;
}

/** The pseudo-minute of `zone`'s wall time at the given instant. */
function wallPseudoMinute(zone: string, epochSeconds: number): number {
  const offset = zoneOffsetSeconds(zone, epochSeconds);
  return Math.floor((epochSeconds + offset) / 60);
}

/** Calendar reads over the pseudo-minute space (UTC arithmetic on wall
 *  fields — the fields themselves are the zone's wall time). */
function wallFieldsOf(pseudoMinute: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const d = new Date(pseudoMinute * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

function dowOfWall(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month, day)).getUTCDay();
}

/** The pseudo-minute of a wall field tuple; month/day overflow (the jump
 *  targets' +1 forms) normalize like the calendar (day 32 → next month). */
function minuteOfWall(year: number, month: number, day: number, hour: number, minute: number): number {
  return Math.floor(Date.UTC(year, month, day, hour, minute) / 60_000);
}

/**
 * Wall → epoch through the zone, the fold/gap arms of the §D7 record:
 * candidate offsets are the ones live within ±24 h of the search instant;
 * a wall time stable under one offset materializes there (a FOLD takes the
 * EARLIER instant — min of the valid epochs; robfig's wall-walk returns the
 * first match too); a wall time stable under NONE is a DST GAP and rounds up
 * through the transition (wall - the smaller offset — robfig's instant
 * stepping crosses the gap at the same wall minute).
 */
function materializeWall(zone: string, afterUnixSeconds: number, pseudoMinute: number): number {
  const wallSeconds = pseudoMinute * 60;
  const offsets = [...new Set([zoneOffsetSeconds(zone, afterUnixSeconds), zoneOffsetSeconds(zone, afterUnixSeconds - 86_400), zoneOffsetSeconds(zone, afterUnixSeconds + 86_400)])];
  const valid: number[] = [];
  for (const off of offsets) {
    const epoch = wallSeconds - off;
    if (zoneOffsetSeconds(zone, epoch) === off) valid.push(epoch);
  }
  if (valid.length > 0) return Math.min(...valid);
  // The gap arm: no offset reproduces the wall time; round up through the
  // transition (the smaller offset maps the wall minute onto the first
  // instant after the jump — the same wall minute, one offset later).
  return wallSeconds - Math.min(...offsets);
}

// ---------------------------------------------------------------------------
// The queue contract (the producer/consumer split — the message carries the
// SPEC ROW id, upstream's row-passing shape: startTasks iterates rows and
// startTask re-reads each row's live state at consume time).
// ---------------------------------------------------------------------------

export interface ActionsScheduleTriggerMessage {
  kind: "actions-trigger";
  /** The action_schedule_spec row id. */
  specId: number;
}

export function isActionsScheduleTriggerMessage(value: unknown): value is ActionsScheduleTriggerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ActionsScheduleTriggerMessage).kind === "actions-trigger" &&
    typeof (value as ActionsScheduleTriggerMessage).specId === "number"
  );
}

/**
 * The clean_repo_schedule_tasks producer's message (services/demo-sweep.ts):
 * one per repo whose registry rows survived an actions-unavailable state —
 * the consumer runs cleanRepoScheduleTasks for it. Idempotent: a redelivery
 * of a cleaned repo deletes zero rows and cancels zero runs.
 */
export interface ActionsScheduleCleanMessage {
  kind: "actions-schedule-clean";
  repoId: string;
}

export function isActionsScheduleCleanMessage(value: unknown): value is ActionsScheduleCleanMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ActionsScheduleCleanMessage).kind === "actions-schedule-clean" &&
    typeof (value as ActionsScheduleCleanMessage).repoId === "string"
  );
}

// ---------------------------------------------------------------------------
// The registry (models/actions/schedule.go + notifier_helper.go handleSchedules)
// ---------------------------------------------------------------------------

/** One detected schedule workflow — the handleSchedules input (upstream's
 *  DetectedWorkflow reduced to what the registry stores). */
export interface DetectedScheduleWorkflow {
  /** The dir-relative entry name (the run/workflow identity). */
  entryName: string;
  /** The workflow source stored on the row (the consume-time run content). */
  content: string;
  /** The cron strings (OnSchedule, actionslib model/workflow.go:90-102 — the
   *  cron-keyed entries only). */
  specs: string[];
}

/** The registration context (upstream's notifyInput + commit, reduced). */
export interface ScheduleRegistryContext {
  repoId: string;
  ownerId: number;
  /** The full ref (the default branch). */
  ref: string;
  /** The tip commit the registry is built from. */
  commitSha: string;
  /** commit.MessageTitle() (notifier_helper.go:634 — the run title source). */
  commitTitle: string;
  /** The registration event ("push" on the push seam — schedule_tasks.go:132
   *  hands it verbatim to every run). */
  event: string;
  /** The event payload captured at registration (the push payload the runs
   *  merge `schedule` into at consume time, schedule_tasks.go:169-206). */
  eventPayload: string;
}

export type ScheduleSpecRow = typeof actionScheduleSpecs.$inferSelect;
export type ScheduleRow = typeof actionSchedules.$inferSelect;

/**
 * handleSchedules (notifier_helper.go:586-649): the registry REPLACE — if
 * rows exist, `DeleteScheduleTaskByRepo` first ("replacing the schedules
 * leaves their in-progress runs alone, as GitHub does", :601-607), then one
 * schedule row per detected workflow through `createScheduleTaskBySchedules`
 * (specs that fail parse or never occur simply register no spec row,
 * schedule.go:63-71). Returns the number of schedule rows created. The
 * caller owns the default-branch gate and the tree detection (trigger.ts's
 * DetectAndHandleSchedules half).
 */
export async function handleSchedules(d1: D1Database, ctx: ScheduleRegistryContext, detected: DetectedScheduleWorkflow[]): Promise<number> {
  // The count gate precedes the replace (:598-607) — and the empty
  // detection (:609-612) returns only AFTER that delete: a push removing the
  // last schedule workflow empties the registry.
  if (await hasAnySchedule(d1, ctx.repoId)) {
    await deleteScheduleTaskByRepo(d1, ctx.repoId);
  }
  if (detected.length === 0) return 0;
  return createScheduleTaskBySchedules(d1, ctx, detected);
}

/** handleSchedules' count (db.Count over FindScheduleOptions, :598). */
async function hasAnySchedule(d1: D1Database, repoId: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: actionSchedules.id })
    .from(actionSchedules)
    .where(eq(actionSchedules.repoId, repoId))
    .limit(1);
  return rows.length > 0;
}

/**
 * CreateScheduleTaskBySchedules (schedule.go:42-79): one schedule row per
 * workflow (Title ellipsized to 255 at insert, :50), then one spec row per
 * cron spec — parse failures skip (:63-66), specs that can never occur
 * (`next.IsZero()`, the five-year horizon) skip (:69-71), the rest store
 * Next = cron.Next(registration instant) with Prev unset (never processed).
 * Returns the schedule rows created.
 */
export async function createScheduleTaskBySchedules(d1: D1Database, ctx: ScheduleRegistryContext, detected: DetectedScheduleWorkflow[]): Promise<number> {
  if (detected.length === 0) return 0;
  const db = drizzle(d1);
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let created = 0;
  for (const wf of detected) {
    const inserted = await db
      .insert(actionSchedules)
      .values({
        // util.EllipsisDisplayString(row.Title, 255) (schedule.go:50)
        title: ellipsisDisplayString(ctx.commitTitle, 255),
        specs: JSON.stringify(wf.specs),
        repoId: ctx.repoId,
        ownerId: ctx.ownerId,
        workflowId: wf.entryName,
        // user_model.ActionsUserID (notifier_helper.go:635)
        triggerUserId: ACTIONS_USER_ID,
        ref: ctx.ref,
        commitSha: ctx.commitSha,
        event: ctx.event,
        eventPayload: ctx.eventPayload,
        content: wf.content,
        created: now,
        updated: now,
      })
      .returning({ id: actionSchedules.id });
    const scheduleId = inserted[0]?.id;
    if (scheduleId === undefined) throw new Error("actions: schedule insert returned no row");
    created += 1;
    for (const specText of wf.specs) {
      let next: number | null;
      try {
        next = cronNext(parseCronSpec(specText), nowSeconds);
      } catch {
        continue; // schedule.go:63-66 — a parse-failing spec registers no row
      }
      if (next === null) continue; // schedule.go:69-71 — the never-occurring skip
      await db.insert(actionScheduleSpecs).values({
        repoId: ctx.repoId,
        scheduleId,
        spec: specText,
        next: new Date(next * 1000),
        prev: null,
        created: now,
        updated: now,
      });
    }
  }
  return created;
}

/**
 * DeleteScheduleTaskByRepo (models/actions/schedule.go:90-102). Disclosed
 * divergence: upstream's model deletes the SCHEDULE rows first and the spec
 * rows second (:91-97), ours deletes specs first — the FK-safer order (a
 * spec row referencing a gone schedule cannot outlive the delete batch) and
 * the order the repo-delete cascade already uses (repos/service.ts's
 * deleteRepository over delete.go:191-192). Nothing reads one table without
 * the other, so the observable is identical either way.
 */
export async function deleteScheduleTaskByRepo(d1: D1Database, repoId: string): Promise<void> {
  const db = drizzle(d1);
  await db.delete(actionScheduleSpecs).where(eq(actionScheduleSpecs.repoId, repoId));
  await db.delete(actionSchedules).where(eq(actionSchedules.repoId, repoId));
}

// ---------------------------------------------------------------------------
// The settings-change arm (services/repository/setting.go:20-64), the clean
// (services/actions/clear_tasks.go:59-63) and the default-branch switch
// (clear_tasks.go:65-77) — the DetectAndHandleSchedules family
// (notifier_helper.go:655-685)
// ---------------------------------------------------------------------------

/**
 * DetectScheduledWorkflows (modules/actions/workflows.go:242-279 — the
 * schedule-carrying workflows of one ref with their OnSchedule cron strings,
 * actionslib model/workflow.go:90-102), over the cell reads. Shared by the
 * standalone detect below; trigger.ts's push-fused twin keeps its own inline
 * walk (not refactored there — the push seam's file is not this arm's owner).
 * A workflow whose content fails GetEventsFromContent is logged and skipped
 * (workflows.go:255-259); one with no cron-keyed schedule entry registers
 * nothing ("no schedule event", notifier_helper.go:622-624).
 */
export async function detectScheduledWorkflows(reads: TriggerCellReads, ref: string): Promise<DetectedScheduleWorkflow[]> {
  const workflowFiles = await listWorkflows(reads, ref);
  const detected: DetectedScheduleWorkflow[] = [];
  for (const file of workflowFiles) {
    let events;
    try {
      events = getEventsFromContent(file.content);
    } catch (err) {
      // GetEventsFromContent's ignore arm (workflows.go:255-259)
      console.error(
        `[actions-schedule] ignore invalid workflow ${file.entryName}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const specs: string[] = [];
    for (const evt of events) {
      if (evt.schedules === null) continue;
      for (const record of evt.schedules) {
        const cron = record["cron"];
        if (typeof cron === "string" && cron !== "") specs.push(cron);
      }
    }
    if (specs.length === 0) continue; // "no schedule event" (:622-624)
    detected.push({ entryName: file.entryName, content: file.content, specs });
  }
  return detected;
}

/**
 * DetectAndHandleSchedules, the STANDALONE entry (notifier_helper.go:655-685)
 * — the settings-change arm's re-walk (setting.go:39), the Actions-user
 * carve-out's registration (notify :147-148) and the Switch's re-register
 * (clear_tasks.go:75) — every caller upstream funnels through this one
 * function. Upstream's body verbatim: the empty/archived skips (:656-658),
 * the DEFAULT-BRANCH tip re-read (:667-670 GetCommit(repo.DefaultBranch) —
 * the caller passes no ref; the repo row's defaultBranch IS the registration
 * ref), the tree enumeration, the ZERO-DETECTION early return (:675-677 —
 * nothing detected leaves the registry UNTOUCHED; the delete lives in
 * handleSchedules and never runs, so a refresh that finds no schedule
 * workflows cannot wipe existing rows — the settings path deletes
 * explicitly first, so its net effect is unchanged), and the registry
 * replace through handleSchedules. Upstream opens its own git handle
 * (:660-664); ours opens its own DO cell reads for the same reason. The
 * registration fields come from the caller: every current caller registers
 * `newNotifyInputForSchedules` verbatim — Event = HookEventSchedule
 * "schedule" and the EncodedPayload of a nil Payload, the literal "null"
 * (notifier_helper.go:82-85) — NOT the push payload, because no push
 * happened on these seams. trigger.ts's same-named function is the push
 * seam's fusion (notify :280-282 hands handleSchedules the PUSH input —
 * event "push", the push payload — and never routes through this
 * standalone, exactly upstream's split).
 */
export async function detectAndHandleSchedules(
  env: ActionsTriggerEnv,
  repo: RepositoryRow,
  registration: { event: string; eventPayload: string },
): Promise<void> {
  // The empty/archived skips (notifier_helper.go:656-658)
  if (repo.isEmpty || repo.isArchived) return;
  const ref = `refs/heads/${repo.defaultBranch}`;
  const reads: TriggerCellReads = env.REPO.getByName(engineName(repo.ownerNamespace, repo.slug));
  const commit = await reads.readCommit(ref);
  if (commit === null) return; // no default branch — nothing can be scheduled
  const detected = await detectScheduledWorkflows(reads, ref);
  // The zero-detection early return (:675-677): upstream returns BEFORE
  // building the notify input and calling handleSchedules, so existing rows
  // survive a refresh that found nothing to register.
  if (detected.length === 0) return;
  await handleSchedules(
    env.DB,
    {
      repoId: repo.id,
      ownerId: repo.ownerId ?? 0,
      ref,
      commitSha: commit.oid,
      commitTitle: commit.subject,
      event: registration.event,
      eventPayload: registration.eventPayload,
    },
    detected,
  );
}

/**
 * CancelPreviousJobs (models/actions/run_job.go:706-723) for the schedule
 * family: the LIVE runs (running/waiting/blocked/cancelling) with
 * trigger_event = schedule on the given ref, workflow filter EMPTY = every
 * workflow — ToConds skips an empty workflow_id. Their job rows cancel per
 * cancelOneJob, and each cancellation rides the UpdateRunJob hook's live
 * halves — the wake when pickable work remains (the task-version bump) and
 * the run aggregate recompute — exactly the sweeps.ts cancelAbandonedJobs
 * precedent (the notifyAndEmitFinishedJobs tail stays the M3 emitter
 * family's staged arm, CleanRepoScheduleTasks' service wrapper only).
 * Errors PROPAGATE to the caller, whose posture is upstream's own. Returns
 * the cancelled job count.
 */
export async function cancelPreviousScheduleJobs(d1: D1Database, repoId: string, ref: string): Promise<number> {
  const db = drizzle(d1);
  const liveRuns = await db
    .select({ id: actionRuns.id })
    .from(actionRuns)
    .where(
      and(
        eq(actionRuns.repoId, repoId),
        eq(actionRuns.ref, ref),
        eq(actionRuns.triggerEvent, "schedule"),
        inArray(actionRuns.status, [
          ACTION_STATUS_RUNNING,
          ACTION_STATUS_WAITING,
          ACTION_STATUS_BLOCKED,
          ACTION_STATUS_CANCELLING,
        ]),
      ),
    );
  if (liveRuns.length === 0) return 0;
  const runIds = liveRuns.map((run) => run.id);
  const jobs = await db.select().from(actionRunJobs).where(inArray(actionRunJobs.runId, runIds)).all();
  let cancelled = 0;
  for (const job of jobs) {
    const now = new Date();
    if (isDoneStatus(job.status)) continue; // cancelOneJob's done arm (run_job.go:806-808)
    if (job.taskId === 0) {
      // cancelOneJob's direct arm behind the just-claimed CAS (:810-819) —
      // a runner claiming in the same instant wins and the cancellation
      // no-ops.
      const updated = await db
        .update(actionRunJobs)
        .set({ status: ACTION_STATUS_CANCELLED, stopped: now, updated: now })
        .where(and(eq(actionRunJobs.id, job.id), eq(actionRunJobs.taskId, 0)))
        .returning({ id: actionRunJobs.id });
      if (updated.length === 0) continue;
    } else {
      // cancelOneJob's claimed arm: stopTask's CANCELLING handshake
      // (CancelJobs' force=false — no forced cancel here).
      try {
        await stopTask(d1, job.taskId, ACTION_STATUS_CANCELLING);
      } catch {
        continue; // the task row vanished — nothing to cancel
      }
    }
    // The UpdateRunJob hook's live halves (run_job.go:503-530), per job —
    // the sweeps.ts precedent.
    if (await hasWaitingJobsToPick(d1, job.repoId)) {
      await increaseTaskVersion(d1, job.ownerId, job.repoId);
    }
    await refreshRunStatus(d1, job.repoId, job.runId, job.runAttemptId);
    cancelled += 1;
  }
  return cancelled;
}

/**
 * CleanRepoScheduleTasks (services/actions/clear_tasks.go:59-63, the notify
 * wrapper → models/actions/schedule.go:104-123): the actions-unavailable
 * cleanup — DeleteScheduleTaskByRepo FIRST ("if actions disabled when there
 * is schedule task, this will remove the outdated schedule tasks", :105-106),
 * then CancelPreviousJobs of this repo's SCHEDULE runs on the DEFAULT
 * BRANCH (:113-117). Errors propagate (upstream's wrapper returns them into
 * the caller's log-and-continue — setting.go:57-60, notifier_helper.go:
 * 157-159, repo.go's archive arm). Returns the cancelled job count.
 */
export async function cleanRepoScheduleTasks(d1: D1Database, repoId: string): Promise<number> {
  // The registry rows go first, verbatim (:108-110).
  await deleteScheduleTaskByRepo(d1, repoId);
  // The default-branch read is a DIRECT repositories probe, not the
  // owner-joined findRepositoryById: the clean must not lose the cancel
  // half to a dangling owner row (the join drops the row entirely), and
  // upstream's clean needs only the repo's DefaultBranch.
  const repoRows = await drizzle(d1)
    .select({ defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .limit(1);
  const defaultBranch = repoRows[0]?.defaultBranch;
  if (defaultBranch === undefined) return 0; // rows gone; no default branch to cancel against
  return cancelPreviousScheduleJobs(d1, repoId, `refs/heads/${defaultBranch}`);
}

/**
 * SwitchSchedulesToDefaultBranch (services/actions/clear_tasks.go:65-77):
 * the default-branch-change cleanup — "cancels the running schedule runs of
 * the old default branch and replaces the schedules with the ones on the
 * current default branch" (:65-66). Three steps, each log-and-continue
 * (upstream logs the step's error and moves to the next, :68-76 — the
 * switch itself never fails):
 *
 *   1. DeleteScheduleTaskByRepo — the registry rows go (:68-70);
 *   2. CancelPreviousJobs against the OLD default's ref — the live schedule
 *      runs of the branch that STOPPED being default cancel (:71-73);
 *   3. the actions-unit-gated re-register from the NEW default through the
 *      standalone detectAndHandleSchedules (:74-77 — its
 *      newNotifyInputForSchedules :82-85 registration, event "schedule" /
 *      payload "null"). Upstream checks `repo.UnitEnabled` directly; ours
 *      probes the repo_units actions row (the landed UnitEnabled reduction).
 *
 * `repo.defaultBranch` MUST already be the NEW default when this is called
 * (upstream's model is mutated before the call — SetRepoDefaultBranch
 * branch.go:717, EditRepo repo.go:718, models RenameBranch :353-361); the
 * re-register reads it. `oldDefaultBranch` is the caller's remembered
 * pre-write name. Wired at the three upstream callers' ports: the API PATCH
 * default_branch arm (routes/repo.ts, repo.go:726-733), the web settings
 * write (branch-protection.tsx applyDefaultBranchForm — SetRepoDefaultBranch
 * branch.go:729) and the default-branch RENAME (ui/index.ts
 * branchRenameSubmit — RenameBranch branch.go:489, which fires only when
 * the renamed branch WAS the default).
 */
export async function switchSchedulesToDefaultBranch(env: ActionsTriggerEnv, repo: RepositoryRow, oldDefaultBranch: string): Promise<void> {
  // 1. The registry rows go (:68-70).
  try {
    await deleteScheduleTaskByRepo(env.DB, repo.id);
  } catch (error) {
    console.error(
      `[actions-schedule] switch-to-default ${repo.ownerNamespace}/${repo.slug}: DeleteScheduleTaskByRepo failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // 2. The OLD default's live schedule runs cancel (:71-73).
  try {
    await cancelPreviousScheduleJobs(env.DB, repo.id, `refs/heads/${oldDefaultBranch}`);
  } catch (error) {
    console.error(
      `[actions-schedule] switch-to-default ${repo.ownerNamespace}/${repo.slug}: CancelPreviousJobs(${oldDefaultBranch}) failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // 3. The unit-gated re-register from the NEW default (:74-77).
  if (!(await repoActionsUnitEnabled(env.DB, repo.id))) return;
  try {
    await detectAndHandleSchedules(env, repo, { event: "schedule", eventPayload: "null" });
  } catch (error) {
    console.error(
      `[actions-schedule] switch-to-default ${repo.ownerNamespace}/${repo.slug}: DetectAndHandleSchedules failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The FindScheduleOptions port (models/actions/schedule_list.go:14-35): the
 * repo/owner filter and upstream's `id DESC` order (ToOrders, :32-34). At
 * the pin the only consumer is handleSchedules' count — this is the read
 * port for the future UI/API family.
 */
export async function getSchedulesByRepo(d1: D1Database, repoId: string, opts: { ownerId?: number } = {}): Promise<ScheduleRow[]> {
  const db = drizzle(d1);
  const conditions = [eq(actionSchedules.repoId, repoId)];
  if (opts.ownerId !== undefined) conditions.push(eq(actionSchedules.ownerId, opts.ownerId));
  return db
    .select()
    .from(actionSchedules)
    .where(and(...conditions))
    .orderBy(desc(actionSchedules.id));
}

// ---------------------------------------------------------------------------
// The ticker half (services/actions/schedule_tasks.go over the queue split)
// ---------------------------------------------------------------------------

/**
 * The producer's SELECT (startTasks' iterate predicate, schedule_tasks.go:38-40:
 * `next > 0 AND next <= now` — the NULL rows (never-scheduled) drop out of
 * the SQLite comparison exactly as the 0-sentinel drops out of upstream's
 * builder.Gt). Ordered by id for a stable scan.
 */
export async function dueScheduleSpecIds(d1: D1Database, nowUnixSeconds: number): Promise<number[]> {
  const db = drizzle(d1);
  const rows = await db
    .select({ id: actionScheduleSpecs.id })
    .from(actionScheduleSpecs)
    .where(lte(actionScheduleSpecs.next, new Date(nowUnixSeconds * 1000)))
    .orderBy(asc(actionScheduleSpecs.id));
  return rows.map((row) => row.id);
}

/**
 * startTask's advance (schedule_tasks.go:66-72 + UpdateScheduleSpec,
 * schedule_spec.go:48-54) with the §D7 CAS: the UPDATE carries the READ
 * prev/next in its WHERE, so of two concurrent deliveries only one reports
 * changes=1 — the winner proceeds to the run insert, the loser skips. True
 * = this delivery owns the occurrence.
 */
export async function advanceScheduleSpecCAS(d1: D1Database, spec: ScheduleSpecRow, newNextUnixSeconds: number): Promise<boolean> {
  const db = drizzle(d1);
  const prevCondition =
    spec.prev === null ? isNull(actionScheduleSpecs.prev) : eq(actionScheduleSpecs.prev, spec.prev);
  // The producer only selects non-NULL next rows, but the type keeps the
  // column's full shape — the NULL arm never fires and never matches.
  const nextCondition =
    spec.next === null ? isNull(actionScheduleSpecs.next) : eq(actionScheduleSpecs.next, spec.next);
  const result = await db
    .update(actionScheduleSpecs)
    .set({ prev: spec.next, next: new Date(newNextUnixSeconds * 1000), updated: new Date() })
    .where(and(eq(actionScheduleSpecs.id, spec.id), prevCondition, nextCondition));
  return (result.meta.changes ?? 0) > 0;
}

/**
 * The consumer arm (startTasks/startTask/CreateScheduleTaskBySpec over one
 * queue delivery — upstream's row-passing shape): one message = one spec
 * row = at most one run. The advance happens FIRST (a failing update cannot
 * duplicate the run, :61; our CAS makes a duplicate delivery lose), then the
 * skips — schedule gone, repo gone, archived (:74-99), the unit gate and the
 * disabled-workflow list (:101-125) — then the run insert through the SAME
 * PrepareRunAndInsert port the push family uses with CreateScheduleTaskBySpec's
 * verbatim fields (Event from the registration, TriggerEvent "schedule",
 * ScheduleID set, the workflow content from REGISTRATION time — upstream's
 * stale-content FIXME, :160). A parse-failing spec, a static-invalid
 * workflow and a failed insert log and consume the occurrence (the spec row
 * already advanced; :42-46's own one-failing-spec posture); only a SYSTEMIC
 * failure (the reads or the advance throwing) propagates for the queue's
 * retry, which the CAS absorbs idempotently. Returns 1 when a run was
 * inserted, 0 otherwise.
 */
export async function handleActionsScheduleTrigger(env: ActionsScheduleConsumerEnv, message: ActionsScheduleTriggerMessage): Promise<number> {
  const { d1 } = env;
  const specRow = await getScheduleSpecById(d1, message.specId);
  if (specRow === null) return 0; // schedule_tasks.go:74-78's own gone-row skip

  const nowSeconds = Math.floor(new Date().getTime() / 1000);
  // The producer's predicate re-checked at consume (startTasks'
  // `next <= now`, :38-40): a redelivery of an already-consumed occurrence
  // arrives with the row's next advanced INTO THE FUTURE — not due, skip.
  // (Upstream never sees such a row — its ticker selects due rows only; our
  // queue arm re-applies the gate so the CAS's exactly-once covers the
  // sequential redelivery too, not just the concurrent twin.)
  if (specRow.next === null || specRow.next.getTime() / 1000 > nowSeconds) return 0;

  let cronSchedule: CronSchedule;
  let newNext: number | null;
  try {
    cronSchedule = parseCronSpec(specRow.spec);
    // startTask's +1m look-ahead (:69 — Next(now.Add(time.Minute))).
    newNext = cronNext(cronSchedule, nowSeconds + 60);
  } catch (err) {
    // A spec that parsed at registration but fails now: log and leave the
    // row due — upstream reports it on every occurrence (:42-46).
    console.error(`[actions-schedule] spec ${specRow.id}: parse "${specRow.spec}" failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  if (newNext === null) {
    // A spec whose next-occurrence search hit the five-year horizon — the
    // advance has nowhere to go; park it far out so the producer stops
    // selecting it (upstream's Next.IsZero() arm zeroes the search — the
    // row-equivalent of the never-occurring skip, schedule.go:69-71).
    await advanceScheduleSpecCAS(d1, specRow, nowSeconds + 10 * 366 * 24 * 3600);
    return 0;
  }

  // THE F7 FIX: advance before insert; a concurrent delivery of the same
  // occurrence loses the CAS and skips.
  const won = await advanceScheduleSpecCAS(d1, specRow, newNext);
  if (!won) return 0;

  // schedule_tasks.go:74-99 — a spec whose schedule or repo row is gone is
  // skipped silently (the advance already happened, exactly upstream).
  const scheduleRow = await getScheduleById(d1, specRow.scheduleId);
  if (scheduleRow === null) return 0;
  const repo = await findRepositoryById(d1, scheduleRow.repoId);
  if (repo === null) return 0;
  // Only archived repos are skipped (:97-99 — mirrors keep their schedules).
  if (repo.repo.isArchived) return 0;
  // The unit gate (:101-121).
  if (!(await repoActionsUnitEnabled(d1, repo.repo.id))) return 0;
  // The disabled-workflow list (:122-125) — the bare entry name space.
  const cfg = await loadRepoActionsConfig(d1, repo.repo.id);
  if (cfg.disabledWorkflows.includes(scheduleRow.workflowId)) return 0;

  try {
    // CreateScheduleTaskBySpec (:113-166): the payload merge
    // (withScheduleInEventPayload, :169-206 — the `schedule` key into the
    // registration payload; the repository/sender objects upstream merges
    // are served by buildGithubContext's dedicated reads on our side) and
    // the run's verbatim field set.
    const eventPayloadJson = withScheduleInEventPayload(scheduleRow.eventPayload, specRow.spec);
    await insertTriggeredRunSplit(
      d1,
      {
        repoId: scheduleRow.repoId,
        ownerId: scheduleRow.ownerId,
        workflowId: scheduleRow.workflowId,
        triggerUserId: scheduleRow.triggerUserId,
        ref: scheduleRow.ref,
        commitSha: scheduleRow.commitSha,
        isForkPullRequest: false,
        event: scheduleRow.event,
        eventPayloadJson,
        triggerEvent: "schedule",
        scheduleId: scheduleRow.id,
        title: scheduleRow.title,
        repoOwnerNamespace: repo.repo.ownerNamespace,
        repoSlug: repo.repo.slug,
        appUrl: env.appUrl,
        // HOOKS' fold: the scheduled run's creation pair (upstream funnels
        // through PrepareRunAndInsert like every producer).
        webhook: env.REPO !== undefined ? { bindings: { DB: d1, REPO: env.REPO }, origin: env.appUrl } : undefined,
      },
      scheduleRow.content,
    );
    return 1;
  } catch (err) {
    // The occurrence is consumed (the spec advanced); the push path's
    // failed-run arm belongs to pushes (:148-156 returns the error into
    // startTasks' log-and-count).
    console.error(
      `[actions-schedule] ${repo.repo.ownerNamespace}/${repo.repo.slug}: run for spec ${specRow.id} (${scheduleRow.workflowId}) failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/** withScheduleInEventPayload (schedule_tasks.go:169-206): merge the
 *  `schedule` key into the registration payload; a nil/empty/unparseable
 *  stored payload starts from a fresh map so the key still lands. */
export function withScheduleInEventPayload(eventPayload: string, spec: string): string {
  if (spec === "") return eventPayload;
  let event: Record<string, unknown>;
  if (eventPayload !== "") {
    try {
      const parsed: unknown = JSON.parse(eventPayload);
      event = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      event = {};
    }
  } else {
    event = {};
  }
  event["schedule"] = spec;
  return JSON.stringify(event);
}

/** The read ports (startTask's GetByID loads, :74-84). */
export async function getScheduleSpecById(d1: D1Database, id: number): Promise<ScheduleSpecRow | null> {
  const db = drizzle(d1);
  const rows = await db.select().from(actionScheduleSpecs).where(eq(actionScheduleSpecs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getScheduleById(d1: D1Database, id: number): Promise<ScheduleRow | null> {
  const db = drizzle(d1);
  const rows = await db.select().from(actionSchedules).where(eq(actionSchedules.id, id)).limit(1);
  return rows[0] ?? null;
}

/** The consumer's env slice (the d1 + the app-url base the github context
 *  needs; the REPO binding is NOT touched — the run content comes from the
 *  registration row). */
export interface ActionsScheduleConsumerEnv {
  d1: D1Database;
  appUrl: string;
  /** HOOKS' fold: the engine cell for the creation emissions' workflow
   *  resolution (scheduled runs fire workflow_run/workflow_job at creation
   *  upstream — PrepareRunAndInsert funnels every producer). */
  REPO?: Env["REPO"];
}

/** The unit gate's readback (notifier_helper.go:162-166 → UnitEnabled): the
 *  repo_units actions row's existence — one indexed probe, kept local so the
 *  consumer pulls no push-family internals in. */
async function repoActionsUnitEnabled(d1: D1Database, repoId: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ repoId: repoUnits.repoId })
    .from(repoUnits)
    .where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions")))
    .limit(1);
  return rows.length > 0;
}
