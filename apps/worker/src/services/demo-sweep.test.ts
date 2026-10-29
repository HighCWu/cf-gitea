/**
 * SPEC-0014 §7 — the DEMO_MODE gate, the hourly demo-sweep producer, and the
 * scheduled dispatch. The gate-off INVARIANT battery is written and run
 * FIRST (§7: "the invariant tests ... run first, always"): with the gate off
 * the producer performs ZERO D1 reads (a tripwire D1 stub that throws on
 * first touch) and ZERO queue sends (a recording queue spy) and logs
 * nothing — the structural claim behind the README's self-host guarantee
 * (§2 hard invariant).
 *
 * Real local D1 (workerd, @cloudflare/vitest-plugin) for the armed halves;
 * the only stubs are the recording Queue (the sync.test.ts recordingQueue
 * pattern) and the gate-off D1 tripwire. The consumer arm is exercised in
 * src/repos/purge.test.ts (the dispatch's own file).
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { repoMirrors, repositories } from "../db/schema";
import {
  DEMO_RETENTION_HOURS,
  DEMO_SWEEP_CRON,
  demoModeEnabled,
  enqueueDueDemoSweeps,
  handleScheduledCron,
  isDemoSweepMessage,
} from "./demo-sweep";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Fixed producer clock. The retention cut is NOW − 72 h. */
const NOW = new Date("2026-06-01T12:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const CUT_SEC = NOW_SEC - DEMO_RETENTION_HOURS * 60 * 60;
const CUT_MS = CUT_SEC * 1000;

/** Recording Queue — counts send/sendBatch AND captures every body (the
 *  sync.test.ts recordingQueue shape, plus the send half the §2 invariant
 *  must also prove silent). */
function spyQueue(): Queue & {
  sends: number;
  sendBodies: unknown[];
  sendBatchCalls: number;
  bodies: unknown[][];
} {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as unknown[],
    sendBatchCalls: 0,
    bodies: [] as unknown[][],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sendBatchCalls += 1;
      queue.bodies.push(messages.map((m) => m.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The gate-off tripwire (§2 "the spy D1 records zero queries"): throws on
 *  the FIRST property touch, so any prepare/batch/exec by gated-off code
 *  fails the test naming what was touched. */
function d1ThatThrows(): D1Database {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`D1 touched while the DEMO_MODE gate is off: .${String(prop)}`);
      },
    },
  ) as D1Database;
}

const totalSends = (queue: ReturnType<typeof spyQueue>): number => queue.sends + queue.sendBatchCalls;

/** Fabricated ScheduledController — the dispatcher reads only `.cron`. */
const cronController = (cron: string): ScheduledController => ({ cron }) as ScheduledController;

/**
 * The dispatcher env with the gate var overridden. The mutation view is the
 * honest way to express "the same deployment, gate armed/unarmed": wrangler
 * types a declared var by its LITERAL config value ("false"), so a spread
 * override alone cannot flip it. Queue/DB overrides still spread over the
 * result.
 */
function scheduledEnv(demoMode: string): Env {
  const copy = { ...env };
  (copy as { DEMO_MODE: string }).DEMO_MODE = demoMode;
  // The audit-retention producer rides the same hourly entry and is NOT
  // demo-gated (SPEC-0015 M4's ratified posture) — pin it DISARMED here so
  // this suite's zero-D1/zero-send tripwires stay about the DEMO gate alone,
  // whatever the surrounding config injects (the ADR-0005 D3 lesson applied
  // at the test-env level; the armed posture is pinned in audit.test.ts
  // under explicit envs).
  (copy as { AUDIT_RETENTION_DAYS?: string }).AUDIT_RETENTION_DAYS = "off";
  return copy;
}

/** The armed producer env: real D1, recording REPO_TASKS. */
const armedEnv = (queue: Queue, demoMode: string): Parameters<typeof enqueueDueDemoSweeps>[0] => ({
  ...env,
  DB: env.DB,
  REPO_TASKS: queue,
  DEMO_MODE: demoMode,
});

async function seedUser(id: number, username: string, opts: { isAdmin?: boolean; type?: "user" | "org" } = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)",
  )
    .bind(id, username, username, opts.isAdmin === true ? 1 : 0, opts.type ?? "user")
    .run();
}

async function seedRepo(
  id: string,
  opts: { ownerId?: number | null; ownerNamespace?: string; slug?: string; createdAt: Date; sizeKb?: number } = {
    createdAt: new Date(0),
  },
): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: opts.ownerNamespace ?? `owner-${id}`,
    ownerId: opts.ownerId ?? null,
    slug: opts.slug ?? `repo-${id}`,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: opts.createdAt,
    // §4.3: the observe-only size report reads this column (settle-time
    // accounting maintains it; the seed plays its role).
    sizeKb: opts.sizeKb ?? 0,
  });
}

/** A due pull-mirror row (dispatch cells: the mirror producers must keep
 *  running on their own entries — their activity is the observable). */
async function seedDueMirror(): Promise<void> {
  await seedUser(60, "mirror-owner");
  await seedRepo("6001", { ownerId: 60, createdAt: new Date(0) });
  await drizzle(env.DB).insert(repoMirrors).values({
    repoId: "6001",
    intervalSeconds: 28800,
    enablePrune: true,
    remoteAddress: "https://src.example.com/org/repo.git",
    syncState: "idle",
    nextSyncAt: 1_700_000_000,
  });
}

const WIPED_TABLES = ["repo_mirrors", "push_mirrors", "repo_counters", "repositories", "repo_redirects"];

async function resetD1(): Promise<void> {
  // Storage isolation resets D1 between tests (apply-d1-migrations.ts
  // header) — re-apply the schema, then wipe defensively anyway.
  await applyAuthD1Migrations();
  for (const table of WIPED_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users").run();
}

// ---------------------------------------------------------------------------
// §7 unit 1 — the gate-off invariant battery (runs FIRST, always)
// ---------------------------------------------------------------------------

describe("the DEMO_MODE gate (§2 invariant — runs first)", () => {
  beforeEach(resetD1);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gate OFF (var unset): ZERO D1 reads, ZERO queue sends, zero log lines", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const queue = spyQueue();
    // The env carries NO DEMO_MODE member at all — the absent-safe-false arm.
    const enqueued = await enqueueDueDemoSweeps({ DB: d1ThatThrows(), REPO_TASKS: queue }, { now: NOW });
    expect(enqueued).toBe(0);
    expect(totalSends(queue)).toBe(0);
    expect(queue.sendBodies).toEqual([]);
    expect(queue.bodies).toEqual([]);
    expect(consoleLog).not.toHaveBeenCalled(); // §6.8: the sweep log's absence pins the arm
  });

  it("gate OFF ('false' default, '1', 'on', 'TRUE', padded): same silence — §6.8 fail-closed", async () => {
    for (const demoMode of ["false", "1", "on", "TRUE", " true", "true "]) {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const queue = spyQueue();
      const enqueued = await enqueueDueDemoSweeps({ DB: d1ThatThrows(), REPO_TASKS: queue, DEMO_MODE: demoMode }, { now: NOW });
      expect(enqueued).toBe(0);
      expect(totalSends(queue)).toBe(0);
      expect(consoleLog).not.toHaveBeenCalled();
    }
  });

  it("the gate function: only the exact string \"true\" arms (absent-safe-false, ALLOW_SIGNUP pattern)", () => {
    expect(demoModeEnabled({})).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: undefined })).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: "false" })).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: "1" })).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: "on" })).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: "TRUE" })).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: "true" })).toBe(true);
  });

  it("armed but REPO_TASKS unbound: fails loud BEFORE the first D1 read (the MIRROR_SYNC_QUEUE guard posture)", async () => {
    const queue = spyQueue();
    await expect(
      enqueueDueDemoSweeps({ DB: d1ThatThrows(), REPO_TASKS: undefined, DEMO_MODE: "true" }, { now: NOW }),
    ).rejects.toThrow(/not bound/);
    expect(queue.sendBatchCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7 unit 2 — the scheduled dispatch (cron string × gate state)
// ---------------------------------------------------------------------------

describe("the scheduled dispatch (§3.1 — handleScheduledCron)", () => {
  beforeEach(resetD1);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("*/10, gate OFF: the mirror producers still run; the sweep never schedules", async () => {
    await seedDueMirror();
    const mirrorQueue = spyQueue();
    const tasksQueue = spyQueue();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleScheduledCron(cronController("*/10 * * * *"), {
      ...scheduledEnv("false"),
      MIRROR_SYNC_QUEUE: mirrorQueue,
      REPO_TASKS: tasksQueue,
    });
    // Mirrors: unconditional, gate-independent (§3.1) — the due row was
    // CAS-claimed and enqueued (and the mirror producer logged its own
    // line); the DEMO producer is the only thing that must stay silent.
    expect(mirrorQueue.bodies).toEqual([[{ kind: "mirror-sync", repoId: "6001" }]]);
    expect(consoleLog.mock.calls.some((args) => String(args[0]).includes("[demo-sweep]"))).toBe(false);
    // The sweep: zero sends on the hourly producer's queue.
    expect(totalSends(tasksQueue)).toBe(0);
  });

  it("*/10, gate ON: mirrors still run; the */10 string NEVER triggers a sweep", async () => {
    await seedDueMirror();
    await seedUser(61, "plain-user");
    await seedRepo("6002", { ownerId: 61, createdAt: new Date(0) }); // 72 h past — sweep-eligible
    const mirrorQueue = spyQueue();
    const tasksQueue = spyQueue();
    await handleScheduledCron(cronController("*/10 * * * *"), {
      ...scheduledEnv("true"),
      MIRROR_SYNC_QUEUE: mirrorQueue,
      REPO_TASKS: tasksQueue,
    });
    expect(mirrorQueue.bodies).toEqual([[{ kind: "mirror-sync", repoId: "6001" }]]);
    // The demo producer dispatches ONLY on the hourly string — even armed
    // and with an eligible repo sitting there, the */10 invocation never
    // schedules cleanup (§7 unit 2, the gate-on cells).
    expect(totalSends(tasksQueue)).toBe(0);
  });

  it("hourly, gate OFF: the invocation performs ZERO D1 reads and ZERO queue sends (§2 arm 1)", async () => {
    await seedDueMirror(); // repos + mirrors exist — nothing may look at them
    const mirrorQueue = spyQueue();
    const tasksQueue = spyQueue();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    // The tripwire DB: ANY D1 access by ANY arm of this invocation throws.
    // §3.1 routes the hourly string ONLY to the self-gating demo producer,
    // so with the gate off the whole invocation returns before its first
    // read — §2's "the hourly cron invocation returns before its first D1
    // read — no SELECT, no enqueue".
    await expect(
      handleScheduledCron(cronController(DEMO_SWEEP_CRON), {
        ...scheduledEnv("false"),
        DB: d1ThatThrows(),
        MIRROR_SYNC_QUEUE: mirrorQueue,
        REPO_TASKS: tasksQueue,
      }),
    ).resolves.toBeUndefined();
    expect(totalSends(mirrorQueue)).toBe(0);
    expect(totalSends(tasksQueue)).toBe(0);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("hourly, gate ON: ONLY the sweep runs — the eligible repo is enqueued, the mirror producers are not dispatched on this string", async () => {
    await seedDueMirror();
    await seedUser(61, "plain-user");
    await seedRepo("6002", { ownerId: 61, createdAt: new Date(0) });
    const mirrorQueue = spyQueue();
    const tasksQueue = spyQueue();
    await handleScheduledCron(cronController(DEMO_SWEEP_CRON), {
      ...scheduledEnv("true"),
      MIRROR_SYNC_QUEUE: mirrorQueue,
      REPO_TASKS: tasksQueue,
    });
    expect(tasksQueue.bodies).toHaveLength(1);
    // Both eligible rows (the seeded mirror repo is also past-retention and
    // plain-user-owned) — order-independent read over the batch.
    const sweptIds = (tasksQueue.bodies[0] as DemoSweepShape[]).map((m) => m.repoId).sort();
    expect(sweptIds).toEqual(["6001", "6002"]);
    // The hourly entry carries ONLY the demo producer (§3.1) — the due
    // mirror row is untouched; the */10 invocation covers minute-0 ticks.
    expect(totalSends(mirrorQueue)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7 unit — the armed producer (candidate selection + logging + guard)
// ---------------------------------------------------------------------------

describe("the armed producer (§3.1 candidate selection)", () => {
  beforeEach(resetD1);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects past-retention rows only: the 72 h boundary is strict, admin-owned exempt, org-owned and NULL-owner swept", async () => {
    await seedUser(70, "plain");
    await seedUser(71, "admin", { isAdmin: true });
    await seedUser(72, "an-org", { type: "org" });
    await seedRepo("inside", { ownerId: 70, createdAt: new Date(CUT_MS + 60_000) }); // younger than 72 h
    await seedRepo("boundary", { ownerId: 70, createdAt: new Date(CUT_MS) }); // EXACTLY 72 h — not "older than"
    await seedRepo("past", { ownerId: 70, createdAt: new Date(CUT_MS - 1000) });
    await seedRepo("admin-repo", { ownerId: 71, ownerNamespace: "admin", createdAt: new Date(0) }); // exempt (§6.2)
    await seedRepo("org-repo", { ownerId: 72, ownerNamespace: "an-org", createdAt: new Date(0) }); // swept
    await seedRepo("orphan", { ownerId: null, createdAt: new Date(0) }); // swept, fail-safe (§3.1 step 2)
    await seedRepo("dangling", { ownerId: 55, createdAt: new Date(0) }); // owner id with NO users row — swept (day-one §5.3 fix)

    const queue = spyQueue();
    const enqueued = await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW });
    expect(enqueued).toBe(4);
    // Membership (the boundary/admin exclusions) — order-independent, since
    // three candidates tie on created_at; strict oldest-first ORDER is the
    // LIMIT test's assertion (distinct timestamps there).
    const sweptIds = (queue.bodies[0] as DemoSweepShape[]).map((m) => m.repoId).sort();
    expect(sweptIds).toEqual(["dangling", "org-repo", "orphan", "past"]);
    expect(queue.bodies[0]!.some((m) => (m as DemoSweepShape).repoId === "boundary")).toBe(false);
  });

  it("the orphan arm (day-one §5.3 finding): a DANGLING owner_id (no users row) is sweep-eligible past retention; retention still gates and the admin-exempt arm is unchanged", async () => {
    await seedUser(70, "plain");
    await seedUser(71, "admin", { isAdmin: true });
    // owner_id 55 has NO users row — the production finding's exact shape
    // (dp3t/p0-shallow, docs/reviews/demo-day1-2026-10-28.md §5.3): under the
    // old predicate the row escaped BOTH arms (owner_id held a value so the
    // IS NULL arm was false, and the join's users.is_admin read NULL, whose
    // `NULL = false` comparison is UNKNOWN — never satisfying the WHERE).
    await seedRepo("dangling-old", { ownerId: 55, ownerNamespace: "dp3t", createdAt: new Date(0) }); // past retention → ENQUEUED
    await seedRepo("dangling-young", { ownerId: 55, createdAt: new Date(CUT_MS + 60_000) }); // inside retention → NOT enqueued
    await seedRepo("admin-repo", { ownerId: 71, ownerNamespace: "admin", createdAt: new Date(0) }); // exempt (§6.2, unchanged)
    await seedRepo("plain-old", { ownerId: 70, createdAt: new Date(0) }); // the unchanged resolvable-non-admin arm

    const queue = spyQueue();
    const enqueued = await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW });
    expect(enqueued).toBe(2);
    const sweptIds = (queue.bodies[0] as DemoSweepShape[]).map((m) => m.repoId).sort();
    expect(sweptIds).toEqual(["dangling-old", "plain-old"]);
    // The retention-gated and admin-exempt rows stay put.
    expect(queue.bodies[0]!.some((m) => (m as DemoSweepShape).repoId === "dangling-young")).toBe(false);
    expect(queue.bodies[0]!.some((m) => (m as DemoSweepShape).repoId === "admin-repo")).toBe(false);
  });

  it("LIMIT truncates oldest-first (§7: the deliberate hourly throttle)", async () => {
    await seedUser(70, "plain");
    await seedRepo("newest-old", { ownerId: 70, createdAt: new Date(CUT_SEC * 1000 - 1000) });
    await seedRepo("older", { ownerId: 70, createdAt: new Date(CUT_SEC * 1000 - 60_000) });
    await seedRepo("oldest", { ownerId: 70, createdAt: new Date(0) });

    const queue = spyQueue();
    const enqueued = await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW, limit: 2 });
    expect(enqueued).toBe(2);
    expect(queue.bodies).toEqual([[{ kind: "demo-sweep", repoId: "oldest" }, { kind: "demo-sweep", repoId: "older" }]]);
  });

  it("logs the batch counts + the §4.3 size roll-up on EVERY armed tick — including the 0-eligible compact one-liner (§3.1 step 4)", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const queue = spyQueue();

    // 0-eligible tick: the one-liner proves the sweep ran (zero-size roll-up).
    const none = await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW });
    expect(none).toBe(0);
    const cutIso = new Date(CUT_SEC * 1000).toISOString();
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith(
      `[demo-sweep] enqueued 0 of 0 eligible (cut ${cutIso}) size total=0 KiB largest=0 KiB (-)`,
    );

    // An eligible tick: N of M with the same cut timestamp; these seeds carry
    // the DEFAULT size 0 — the roll-up is honest at zero (the named largest
    // is the oldest candidate at 0 KiB; only the EMPTY batch prints "-").
    await seedUser(70, "plain");
    await seedRepo("past-1", { ownerId: 70, createdAt: new Date(0) });
    await seedRepo("past-2", { ownerId: 70, createdAt: new Date(CUT_MS - 500) });
    consoleLog.mockClear();
    const two = await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW });
    expect(two).toBe(2);
    expect(consoleLog).toHaveBeenCalledWith(
      `[demo-sweep] enqueued 2 of 2 eligible (cut ${cutIso}) size total=0 KiB largest=0 KiB (owner-past-1/repo-past-1)`,
    );
  });

  it("the §4.3 size roll-up rides the same one-line log: batch total + the named largest (observe-only — OQ-4)", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const queue = spyQueue();
    await seedUser(70, "plain");
    await seedRepo("tiny", { ownerId: 70, createdAt: new Date(0), sizeKb: 12 });
    await seedRepo("hog", { ownerId: 70, createdAt: new Date(CUT_MS - 1000), sizeKb: 1500 });
    await seedRepo("mid", { ownerId: 70, createdAt: new Date(CUT_MS - 2000), sizeKb: 188 });

    const enqueued = await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW });
    expect(enqueued).toBe(3);
    const cutIso = new Date(CUT_SEC * 1000).toISOString();
    // total = 12 + 1500 + 188; largest names owner/slug (the runbook's aim).
    expect(consoleLog).toHaveBeenCalledWith(
      `[demo-sweep] enqueued 3 of 3 eligible (cut ${cutIso}) size total=1700 KiB largest=1500 KiB (owner-hog/repo-hog)`,
    );
    // The rows are NOT consumed by a producer tick (row deletion is the
    // consumer's claim, §3.1) — the next tick re-reads and re-reports the
    // full aging set, roll-up included.
    consoleLog.mockClear();
    await seedRepo("extra", { ownerId: 70, createdAt: new Date(CUT_MS - 3000), sizeKb: 500 });
    await enqueueDueDemoSweeps(armedEnv(queue, "true"), { now: NOW });
    expect(consoleLog).toHaveBeenCalledWith(
      `[demo-sweep] enqueued 4 of 4 eligible (cut ${cutIso}) size total=2200 KiB largest=1500 KiB (owner-hog/repo-hog)`,
    );
  });

  it("the real config's shipped DEMO_MODE keeps the producer silent (the default deployment's posture)", async () => {
    const queue = spyQueue();
    // env.DEMO_MODE as deployed: the example/real configs ship "false".
    const enqueued = await enqueueDueDemoSweeps({ ...env, REPO_TASKS: queue }, { now: NOW });
    expect(enqueued).toBe(0);
    expect(totalSends(queue)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7 unit — the message narrowing guard (§3.2, the isMirrorSyncMessage shape)
// ---------------------------------------------------------------------------

type DemoSweepShape = { kind: "demo-sweep"; repoId: string };

describe("isDemoSweepMessage narrowing (§3.2)", () => {
  it("accepts only {kind: \"demo-sweep\", repoId: string}", () => {
    expect(isDemoSweepMessage({ kind: "demo-sweep", repoId: "r_1" })).toBe(true);
  });

  it("rejects the other repo-tasks families' shapes and junk", () => {
    // The purge family (structurally kind-less — purge.ts:45-53)
    expect(isDemoSweepMessage({ storageKey: "r_1", engineNames: ["a/b"] })).toBe(false);
    // The sibling typed families (sync.ts:155-161, push-sync, fork, imports)
    expect(isDemoSweepMessage({ kind: "mirror-sync", repoId: "r_1" })).toBe(false);
    expect(isDemoSweepMessage({ kind: "push-mirror-sync", repoId: "r_1", pushMirrorId: 3 })).toBe(false);
    expect(isDemoSweepMessage({ kind: "repo-fork", sourceRepoId: "r_1", forkRepoId: "r_2" })).toBe(false);
    expect(isDemoSweepMessage({ kind: "import-chunk", importId: 7, repoId: "r_1", chunk: 3 })).toBe(false);
    // Incomplete / mistyped demo shapes
    expect(isDemoSweepMessage({ kind: "demo-sweep" })).toBe(false);
    expect(isDemoSweepMessage({ kind: "demo-sweep", repoId: 5 })).toBe(false);
    // Primitives and null
    expect(isDemoSweepMessage(null)).toBe(false);
    expect(isDemoSweepMessage("demo-sweep")).toBe(false);
    expect(isDemoSweepMessage(42)).toBe(false);
    expect(isDemoSweepMessage(undefined)).toBe(false);
  });
});
