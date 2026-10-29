/**
 * SPEC-0014 §3.0 (repo-tasks DLQ) tests for `src/repos/dlq.ts` — the
 * log-and-ack contract, stub queue batches + console spy (the webhook DLQ
 * test's house pattern). The handler performs no I/O HERE: the SPEC-0018
 * §3.1 notice emit needs a DB, and these unit stubs pass none — every
 * message additionally takes the §5.3 log-only degrade line, which the
 * `redriveLines` filter separates from the asserted redrive lines. The emit
 * seam's positive-path tests (rows per family, the degrade arm, the clip)
 * live in services/notices.test.ts over real D1.
 */

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { repoTasksDlqHandler } from "./dlq";

function stubBatch(bodies: unknown[]): {
  batch: MessageBatch<unknown>;
  acked: () => number;
  retried: () => number;
} {
  const counters = { ack: 0, retry: 0 };
  const batch: MessageBatch<unknown> = {
    queue: "repo-tasks-dlq",
    metadata: { metrics: { backlogCount: bodies.length, backlogBytes: 0 } },
    messages: bodies.map((body, index) => ({
      id: `dlq-${index}`,
      timestamp: new Date(),
      body,
      attempts: 5,
      ack: () => {
        counters.ack++;
      },
      retry: () => {
        counters.retry++;
      },
    })),
    ackAll: () => {
      counters.ack += bodies.length;
    },
    retryAll: () => {
      counters.retry += bodies.length;
    },
  };
  return { batch, acked: () => counters.ack, retried: () => counters.retry };
}

// One body per handleRepoTasks family (purge.ts dispatch arms) — the exact
// shapes the producers enqueue, verbatim.
const KNOWN_FAMILIES: unknown[] = [
  // Repo delete purge (SPEC-0003 §2.5.5 — no `kind` field; the
  // SQLITE_LOCKED purge-drop finding's family).
  { storageKey: "r_42", engineNames: ["alice/proj", "alice/proj~renamed"] },
  // Import pipeline (SPEC-0003 §2.6)
  { kind: "import-chunk", importId: 7, repoId: "r_42", chunk: 3 },
  { kind: "import-abort", importId: 8, repoId: "r_43" },
  { kind: "import-sweep", importId: 9, repoId: "r_44" },
  // Fork replication
  { kind: "repo-fork", sourceRepoId: "r_1", forkRepoId: "r_2" },
  // Pull-mirror sync (SPEC-0009 §2.6)
  { kind: "mirror-sync", repoId: "r_5" },
  // Push-mirror outbound sync
  { kind: "push-mirror-sync", repoId: "r_6", pushMirrorId: 12 },
];

function loggedLines(consoleError: MockInstance): string[] {
  return consoleError.mock.calls.map((args) => args.map(String).join(" "));
}

/** The redrive log lines only — every [repo-tasks-dlq] record line (and the
 *  hostile-body fallback line) carries the verbatim `body=` field; the
 *  SPEC-0018 emit-degrade lines do not, so the filter isolates the contract
 *  under assertion from the §5.3 log-only degrade noise the DB-less stub
 *  produces per message. */
function redriveLines(consoleError: MockInstance): string[] {
  return loggedLines(consoleError).filter((line) => line.includes("body="));
}

describe("repoTasksDlqHandler (SPEC-0014 §3.0)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs and acks every known family with its redrive fields and verbatim body", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = stubBatch(KNOWN_FAMILIES);
    await repoTasksDlqHandler(batch, {} as Env, {} as ExecutionContext);

    expect(acked()).toBe(KNOWN_FAMILIES.length);
    expect(retried()).toBe(0);

    const lines = redriveLines(consoleError);
    expect(lines).toHaveLength(KNOWN_FAMILIES.length);
    expect(lines.every((line) => line.includes("[repo-tasks-dlq]"))).toBe(true);
    expect(lines.every((line) => line.includes("kind="))).toBe(true);
    expect(lines.some((line) => line.includes("kind=unknown"))).toBe(false);

    // The purge body verbatim: storageKey + every engineName (the whole
    // redrive payload — the finding's orphan was resurrected from exactly
    // these two fields).
    expect(
      lines.some(
        (line) =>
          line.includes("kind=repo-purge") &&
          line.includes('body={"storageKey":"r_42","engineNames":["alice/proj","alice/proj~renamed"]}'),
      ),
    ).toBe(true);

    // Import chunk: kind + ids + the chunk index.
    expect(
      lines.some(
        (line) =>
          line.includes("kind=import-chunk") &&
          line.includes('"importId":7') &&
          line.includes('"repoId":"r_42"') &&
          line.includes('"chunk":3'),
      ),
    ).toBe(true);

    // Fork, pull-mirror, push-mirror: the typed kind and its ids.
    expect(
      lines.some((line) => line.includes("kind=repo-fork") && line.includes('"sourceRepoId":"r_1"') && line.includes('"forkRepoId":"r_2"')),
    ).toBe(true);
    expect(lines.some((line) => line.includes("kind=mirror-sync") && line.includes('body={"kind":"mirror-sync","repoId":"r_5"}'))).toBe(
      true,
    );
    expect(
      lines.some((line) => line.includes("kind=push-mirror-sync") && line.includes('"repoId":"r_6"') && line.includes('"pushMirrorId":12')),
    ).toBe(true);

    // Message id + attempts ride every line (full observability context).
    expect(lines.every((line) => line.includes("id=dlq-") && line.includes("attempts=5"))).toBe(true);
  });

  it("logs and acks malformed and unknown bodies (never crashes on them)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = stubBatch(["not-json{{", '"a json string, no known kind"', 42, null, { oops: true }]);
    await repoTasksDlqHandler(batch, {} as Env, {} as ExecutionContext);

    expect(acked()).toBe(5);
    expect(retried()).toBe(0);
    const lines = redriveLines(consoleError);
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.includes("kind=unknown"))).toBe(true);
    // The malformed string is logged verbatim — a redrive can still see it.
    expect(lines.some((line) => line.includes("body=not-json{{"))).toBe(true);
    expect(lines.some((line) => line.includes("body=null"))).toBe(true);
    expect(lines.some((line) => line.includes('body={"oops":true}'))).toBe(true);
  });

  it("treats an empty batch as a no-op", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = stubBatch([]);
    await expect(repoTasksDlqHandler(batch, {} as Env, {} as ExecutionContext)).resolves.toBeUndefined();
    expect(acked()).toBe(0);
    expect(retried()).toBe(0);
    expect(loggedLines(consoleError)).toHaveLength(0);
  });

  it("NEVER throws: cyclic and hostile-getter bodies still get a line and their ack", async () => {
    const cyclic: Record<string, unknown> = { kind: "mirror-sync", repoId: "r_cyc" };
    cyclic.self = cyclic; // JSON.stringify throws on the cycle
    const hostile = {
      // The purge guard reads .storageKey first — this getter throws.
      get storageKey(): string {
        throw new Error("getter boom");
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = stubBatch([cyclic, hostile]);

    // The handler does not throw — a throwing arm in a fed message never
    // escapes, and both messages still got their ack.
    await expect(repoTasksDlqHandler(batch, {} as Env, {} as ExecutionContext)).resolves.toBeUndefined();
    expect(acked()).toBe(2);
    expect(retried()).toBe(0);

    const lines = redriveLines(consoleError);
    // The cyclic body: classified, and its body logged via the guarded
    // serializer's unserializable marker instead of crashing.
    expect(lines.some((line) => line.includes("dlq-0") && line.includes("kind=mirror-sync") && line.includes("<unserializable:"))).toBe(
      true,
    );
    // The hostile getter: the fallback arm still emits an id-bearing
    // [repo-tasks-dlq] line for the message, and the ack already happened.
    expect(lines.some((line) => line.includes("dlq-1") && line.includes("[repo-tasks-dlq]"))).toBe(true);
  });

  it("the SPEC-0018 emit degrades to log-only when no DB is bound (the §5.3 posture, per message)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked } = stubBatch([{ kind: "mirror-sync", repoId: "r_5" }]);
    await repoTasksDlqHandler(batch, {} as Env, {} as ExecutionContext);
    expect(acked()).toBe(1); // the ack path is untouched by the emit failure
    const all = loggedLines(consoleError);
    // The redrive line AND the degrade line both carried the fact.
    expect(redriveLines(consoleError)).toHaveLength(1);
    expect(all.some((line) => line.includes("notice emit degraded to log-only") && line.includes("dlq-0"))).toBe(true);
  });
});
