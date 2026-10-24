/**
 * REPO_TASKS mirror-sync dispatch wiring (SPEC-0009 §2.6) — the third message
 * family in handleRepoTasks (src/repos/purge.ts): the cron producer
 * (src/index.ts scheduled → enqueueDueMirrorSyncs) enqueues
 * {kind: "mirror-sync", repoId} onto repo-tasks, and the consumer arm must
 * drive handleMirrorSync per message with the family's ack/retry discipline.
 *
 * Real local D1 (workerd, @cloudflare/vitest-plugin), no module mocks — the
 * dispatch is proven by the ack/retry DIFFERENTIAL against the drop path:
 *
 *   - handleMirrorSync that THROWS surfaces as message.retry() (its documented
 *     queue-retry signal); the malformed-drop path acks instead. Test 1 runs
 *     before this file's migrations exist, so the handler's first query
 *     (repositories) rejects — a real error through the real dispatch.
 *   - handleMirrorSync that settles WITHOUT throwing (repo row absent →
 *     {ok: false, skipped: "missing-row"} — a delete raced the sync) must
 *     ack, never retry.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { handleRepoTasks } from "./purge";

/** Fabricated MessageBatch with ack/retry recorders (imports.test.ts shape). */
function fabricatedBatch(bodies: { id: string; body: unknown }[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "repo-tasks",
    messages: bodies.map(({ id, body }) => ({
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
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

describe("REPO_TASKS mirror-sync dispatch (SPEC-0009 §2.6 wiring)", () => {
  it("routes a mirror-sync message through the real handler (a thrown sync retries)", async () => {
    // No migrations applied yet in this file's storage: handleMirrorSync's
    // first D1 read (repositories) rejects, and that throw must surface as a
    // RETRY — proof the arm dispatched. A malformed/dropped message acks
    // instead, so the garbage control pins the differential.
    const { batch, acked, retried } = fabricatedBatch([
      { id: "mirror", body: { kind: "mirror-sync", repoId: "r_dispatch" } },
      { id: "garbage", body: { hello: true } },
    ]);

    await handleRepoTasks(batch, env);

    expect(retried).toEqual(["mirror"]);
    expect(acked).toEqual(["garbage"]);
  });

  it("acks a mirror-sync message the handler settles without throwing", async () => {
    // With the schema applied the handler's first read succeeds and returns
    // {ok: false, skipped: "missing-row"} for the absent repo — a HANDLED
    // terminal outcome (a delete raced the sync), which must ack.
    await applyAuthD1Migrations();
    const { batch, acked, retried } = fabricatedBatch([
      { id: "mirror", body: { kind: "mirror-sync", repoId: "r_absent" } },
    ]);

    await handleRepoTasks(batch, env);

    expect(acked).toEqual(["mirror"]);
    expect(retried).toEqual([]);
  });
});
