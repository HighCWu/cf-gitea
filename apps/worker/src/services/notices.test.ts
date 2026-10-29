/**
 * The system-notices suite (SPEC-0018 §3.1/§4.1/§5/§6): the model/service
 * seam over real D1 (generated migrations in beforeAll — the landed service
 * idiom) AND the emit seam's positive path — the repo-tasks DLQ consumer
 * (repos/dlq.ts) writing one notice per dead letter, the §3.1 type mapping
 * over the dispatch families, the §5.2 description clip, the §5.3
 * degrade-to-log-only contract, and the §5.1 emit-vs-retry rule (the
 * retrying consumer's arms write NO rows; only the DLQ arrival emits).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { repoTasksDlqHandler } from "../repos/dlq";
import { handleRepoTasks } from "../repos/purge";
import {
  ADMIN_NOTICES_PAGE_SIZE,
  clipNoticeDescription,
  countNotices,
  deleteNoticesByIds,
  emptyNotices,
  listNotices,
  parseNoticeIds,
  recordNotice,
} from "./notices";

const T0 = new Date("2026-01-01T00:00:00Z");

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM system_notices").run();
});

// --- the model (§4.1): insert, count, the paged DESC read ---------------------

describe("recordNotice + countNotices + listNotices (§2.2's notice.go:76-88)", () => {
  it("inserts rendered descriptions and counts them", async () => {
    await recordNotice(env.DB, { type: 1, description: "repo-purge for r_42 dead-lettered after 5 attempts: boom", now: T0 });
    await recordNotice(env.DB, { type: 2, description: "audit-retention dead-lettered after 5 attempts: boom", now: T0 });
    expect(await countNotices(env.DB)).toBe(2);
  });

  it("orders created_unix DESC with the id DESC tiebreak under equal timestamps (§5.7)", async () => {
    // Three rows in ONE second — a DLQ batch's shape. Insertion order a, b, c
    // must read back c, b, a (the id tiebreak keeps the batch's order).
    for (const label of ["a", "b", "c"]) {
      await recordNotice(env.DB, { type: 1, description: `notice ${label}`, now: T0 });
    }
    await recordNotice(env.DB, { type: 1, description: "newer", now: new Date(T0.getTime() + 1000) });
    const rows = await listNotices(env.DB, 1);
    expect(rows.map((row) => row.description)).toEqual(["newer", "notice c", "notice b", "notice a"]);
    expect(rows[0]!.createdUnix).toEqual(new Date(T0.getTime() + 1000));
  });

  it("pages 25 per page (upstream NoticePagingNum) over the DESC window", async () => {
    for (let i = 0; i < ADMIN_NOTICES_PAGE_SIZE + 3; i++) {
      await recordNotice(env.DB, { type: 1, description: `n${String(i).padStart(2, "0")}`, now: new Date(T0.getTime() + i * 1000) });
    }
    const page1 = await listNotices(env.DB, 1);
    expect(page1).toHaveLength(ADMIN_NOTICES_PAGE_SIZE);
    expect(page1[0]!.description).toBe("n27"); // newest first
    const page2 = await listNotices(env.DB, 2);
    expect(page2).toHaveLength(3);
    expect(page2[0]!.description).toBe("n02"); // the DESC window continues
    expect(await listNotices(env.DB, 3)).toHaveLength(0);
    expect(await countNotices(env.DB)).toBe(28);
  });
});

// --- the §5.2 bound ------------------------------------------------------------

describe("clipNoticeDescription (§5.2/§8.4 — the 2000-char bound)", () => {
  it("passes short lines through untouched", () => {
    const line = "repo-purge for r_42 dead-lettered after 5 attempts: boom";
    expect(clipNoticeDescription(line)).toBe(line);
    expect(clipNoticeDescription("x".repeat(2000))).toHaveLength(2000);
  });

  it("suffix-truncates to exactly 2000 chars WITH the visible ellipsis", () => {
    const clipped = clipNoticeDescription("y".repeat(2001));
    expect(clipped).toHaveLength(2000);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.startsWith("y".repeat(1999))).toBe(true);
  });

  it("recordNotice clips AT EMIT — the stored row never exceeds the bound", async () => {
    await recordNotice(env.DB, { type: 2, description: "z".repeat(5000), now: T0 });
    const rows = await listNotices(env.DB, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toHaveLength(2000);
    expect(rows[0]!.description.endsWith("…")).toBe(true);
  });
});

// --- the ids[] discipline + the deletes (§5.4, notice.go:46-75) ----------------

describe("parseNoticeIds + deleteNoticesByIds + emptyNotices", () => {
  it("mirrors upstream's ParseInt discipline: junk and non-positive entries never survive", () => {
    expect(parseNoticeIds(["12", "abc", "12abc", "0", "-5", "007", "+3", ""])).toEqual([12, 7, 3]);
    expect(parseNoticeIds([])).toEqual([]);
    // JS parseInt would take "12abc" → 12; Go's ParseInt errors on it and
    // upstream ignores the entry — the digits-only gate mirrors that.
  });

  it("deletes exactly the given ids; an empty set is a no-op success", async () => {
    for (const label of ["a", "b", "c"]) {
      await recordNotice(env.DB, { type: 1, description: label, now: T0 });
    }
    const all = await listNotices(env.DB, 1, 100);
    const deleted = await deleteNoticesByIds(env.DB, [all[0]!.id, all[2]!.id]);
    expect(deleted).toBe(2);
    expect((await listNotices(env.DB, 1, 100)).map((row) => row.description)).toEqual(["b"]);
    expect(await deleteNoticesByIds(env.DB, [])).toBe(0); // the empty-after-filter arm
    expect(await countNotices(env.DB)).toBe(1);
    // Unknown ids delete nothing and still succeed (the stale-form arm).
    expect(await deleteNoticesByIds(env.DB, [999_001])).toBe(0);
  });

  it("empties a populated table and answers 0 on an already-empty one (§5.8)", async () => {
    for (let i = 0; i < 5; i++) {
      await recordNotice(env.DB, { type: 2, description: `t${i}`, now: T0 });
    }
    expect(await emptyNotices(env.DB)).toBe(5);
    expect(await countNotices(env.DB)).toBe(0);
    expect(await emptyNotices(env.DB)).toBe(0); // the no-op success
  });
});

// --- the emit seam (§3.1): one notice per dead letter, typed over families -----

/** A stub batch shaped like the dlq.test.ts harness, with the acks counted. */
function stubBatch(bodies: unknown[]): { batch: MessageBatch<unknown>; acked: () => number } {
  let acks = 0;
  const batch: MessageBatch<unknown> = {
    queue: "repo-tasks-dlq",
    metadata: { metrics: { backlogCount: bodies.length, backlogBytes: 0 } },
    messages: bodies.map((body, index) => ({
      id: `dlq-${index}`,
      timestamp: new Date(),
      body,
      attempts: 5,
      ack: () => {
        acks++;
      },
      retry: () => {},
    })),
    ackAll: () => {
      acks += bodies.length;
    },
    retryAll: () => {},
  };
  return { batch, acked: () => acks };
}

describe("repoTasksDlqHandler → recordNotice (§3.1 — the SPEC's contribution)", () => {
  let consoleError: MockInstance;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits type 1 for every repo-scoped family, with kind + identity + attempts + the body digest", async () => {
    const { batch, acked } = stubBatch([
      { storageKey: "r_42", engineNames: ["alice/proj"] }, // the purge family — structurally no kind
      { kind: "import-chunk", importId: 7, repoId: "r_42", chunk: 3 },
      { kind: "repo-fork", sourceRepoId: "r_1", forkRepoId: "r_2" },
      { kind: "mirror-sync", repoId: "r_5" },
      { kind: "push-mirror-sync", repoId: "r_6", pushMirrorId: 12 },
    ]);
    await repoTasksDlqHandler(batch, env, {} as ExecutionContext);
    expect(acked()).toBe(5);

    const rows = await listNotices(env.DB, 1, 100);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.type === 1)).toBe(true);
    const descriptions = rows.map((row) => row.description);
    expect(descriptions).toContain("repo-purge for r_42 dead-lettered after 5 attempts: " + JSON.stringify({ storageKey: "r_42", engineNames: ["alice/proj"] }));
    expect(descriptions.some((line) => line.startsWith("import-chunk for r_42 dead-lettered after 5 attempts: ") && line.includes('"importId":7'))).toBe(true);
    // The FORK's identity is the fork repo (the replication that failed).
    expect(descriptions.some((line) => line.startsWith("repo-fork for r_2 dead-lettered after 5 attempts: "))).toBe(true);
    expect(descriptions).toContain("mirror-sync for r_5 dead-lettered after 5 attempts: " + JSON.stringify({ kind: "mirror-sync", repoId: "r_5" }));
    expect(descriptions.some((line) => line.startsWith("push-mirror-sync for r_6 dead-lettered after 5 attempts: ") && line.includes('"pushMirrorId":12'))).toBe(true);
  });

  it("emits type 2 for the instance-scoped riders (demo-sweep, audit-retention) and unclassifiable bodies", async () => {
    const { batch } = stubBatch([
      { kind: "demo-sweep", repoId: "r_9" },
      { kind: "audit-retention" }, // no repo identity — the "for" clause drops
      { oops: true }, // unknown — cannot claim a repo
    ]);
    await repoTasksDlqHandler(batch, env, {} as ExecutionContext);

    const rows = await listNotices(env.DB, 1, 100);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.type === 2)).toBe(true);
    const descriptions = rows.map((row) => row.description);
    expect(descriptions).toContain("demo-sweep for r_9 dead-lettered after 5 attempts: " + JSON.stringify({ kind: "demo-sweep", repoId: "r_9" }));
    expect(descriptions).toContain("audit-retention dead-lettered after 5 attempts: " + JSON.stringify({ kind: "audit-retention" }));
    expect(descriptions.some((line) => line.startsWith("unknown dead-lettered after 5 attempts: "))).toBe(true);
  });

  it("clips a monster body at the §5.2 bound — the row survives the clip", async () => {
    const monster = { kind: "import-chunk", importId: 7, repoId: "r_big", blob: "x".repeat(5000) };
    const { batch } = stubBatch([monster]);
    await repoTasksDlqHandler(batch, env, {} as ExecutionContext);
    const rows = await listNotices(env.DB, 1, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toHaveLength(2000);
    expect(rows[0]!.description.startsWith("import-chunk for r_big dead-lettered after 5 attempts: ")).toBe(true);
    expect(rows[0]!.description.endsWith("…")).toBe(true);
  });

  it("the §5.3 degrade: a DB that rejects the insert still logs + acks, and never throws", async () => {
    // The demo-sweep.test.ts rejecting-D1 idiom: a Proxy whose every touch
    // throws (the drizzle driver's first `prepare` reaches the trap).
    const rejecting = new Proxy(
      {},
      {
        get() {
          throw new Error("disk full");
        },
      },
    ) as D1Database;
    const { batch, acked } = stubBatch([{ kind: "mirror-sync", repoId: "r_5" }]);
    await expect(repoTasksDlqHandler(batch, { DB: rejecting } as Env, {} as ExecutionContext)).resolves.toBeUndefined();
    expect(acked()).toBe(1); // the ack path is untouched by the emit failure
    const all = consoleError.mock.calls.map((args) => args.map(String).join(" "));
    expect(all.some((line) => line.includes("[repo-tasks-dlq]") && line.includes("kind=mirror-sync") && line.includes("body="))).toBe(true);
    expect(all.some((line) => line.includes("notice emit degraded to log-only") && line.includes("disk full"))).toBe(true);
    expect(await countNotices(env.DB)).toBe(0); // nothing half-written
  });

  it("the §5.1 spam rule: the RETRYING consumer's arms write no rows — only the DLQ arrival emits", async () => {
    // The retrying consumer driven over its cheap arms (a missing-row mirror
    // sync, the retention prune, and a malformed poison body) on REAL D1:
    // every outcome — ack, skip, drop, even a propagating retry signal —
    // leaves system_notices EMPTY. A transient is not a notice (§5.1).
    const { batch: tasks } = stubBatch([
      { kind: "mirror-sync", repoId: "r_missing" },
      { kind: "audit-retention" },
      "not-json{{",
    ]);
    await handleRepoTasks(tasks, env).catch(() => undefined); // a throw IS the retry signal
    expect(await countNotices(env.DB)).toBe(0);

    // The SAME message, terminal: the platform dead-letters it after
    // max_retries and the DLQ consumer emits EXACTLY ONE notice (no
    // per-attempt duplication — slice one emits ONLY here, §8.3).
    const { batch: dead } = stubBatch([{ kind: "mirror-sync", repoId: "r_missing" }]);
    await repoTasksDlqHandler(dead, env, {} as ExecutionContext);
    const rows = await listNotices(env.DB, 1, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(1);
    expect(rows[0]!.description.startsWith("mirror-sync for r_missing dead-lettered after 5 attempts: ")).toBe(true);
  });
});
