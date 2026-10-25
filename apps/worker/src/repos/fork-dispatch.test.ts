/**
 * REPO_TASKS fork dispatch wiring — the regression for the dropped-fork bug
 * (2026-10-25): handleRepoTasks had import/mirror-sync/purge arms but NO
 * fork arm, so the {kind: "repo-fork"} message the forks API enqueues fell
 * through to the malformed-purge branch and was ACKED-DROPPED — POST /forks
 * answered 202 and the replication never ran (the repo stayed 'creating').
 *
 * Proof is the ack/retry DIFFERENTIAL against the drop path (purge.test.ts
 * convention): this file runs BEFORE any migration, so handleForkMessage's
 * first D1 read (repositories) rejects, and runForkTask's catch turns that
 * into message.retry(). The old code ACKED the same message — the assertion
 * below fails on it by construction.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleRepoTasks } from "./purge";

function fabricatedBatch(bodies: { id: string; body: unknown }[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "repo-tasks",
    messages: bodies.map(({ id, body }) => ({
      id,
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => {
        acked.push(id);
      },
      retry: () => {
        retried.push(id);
      },
    })),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => {
      retried.push("all");
    },
    ackAll: () => {
      acked.push("all");
    },
  };
  return { batch, acked, retried };
}

describe("REPO_TASKS fork dispatch (the dropped-fork regression)", () => {
  it("routes a repo-fork message through the real handler (retry on throw, never the malformed-drop ack)", async () => {
    const { batch, acked, retried } = fabricatedBatch([
      { id: "fork", body: { kind: "repo-fork", sourceRepoId: "r_src", forkRepoId: "r_fork" } },
      { id: "garbage", body: { hello: true } },
    ]);

    await handleRepoTasks(batch, env);

    // The fork message reached runForkTask (its catch retried on the
    // unmigrated-D1 error); garbage still acks via the malformed branch.
    expect(retried).toEqual(["fork"]);
    expect(acked).toEqual(["garbage"]);
  });
});
