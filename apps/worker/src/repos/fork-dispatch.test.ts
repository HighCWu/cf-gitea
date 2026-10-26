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

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { repositories, users } from "../db/schema";
import { findRepositoryById, toApiRepository } from "../api/services/repository";
import { settleForkRow } from "./fork-task";
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

/**
 * The fork settle's `repositories.num_forks` tally (migration 0031) —
 * upstream bumps the SOURCE inside ForkRepository's creation transaction
 * (services/repository/fork.go:110-113 → IncrementRepoForkNum,
 * models/repo/fork.go:57-61, the sole call site: the template-generate copy
 * has no IncrementRepoForkNum arm), rendered as the API `forks_count`
 * (convert/repository.go:220 `Forks: repo.NumForks`). Here the increment
 * rides the settle's own D1 batch, guarded by the fork row still being
 * 'creating' — exactly-once with the CAS (migrations are applied HERE, after
 * the unmigrated dispatch regression above has run).
 */
describe("REPO_TASKS fork settle num_forks tally (migration 0031)", () => {
  let db: DrizzleD1Database;

  beforeAll(async () => {
    if (env.TEST_MIGRATIONS === undefined) {
      throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
    }
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    db = drizzle(env.DB);
  });

  beforeEach(async () => {
    for (const table of ["stars", "repositories", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  /** An owner + a ready source + one 'creating' fork row pointing at it. */
  async function seedForkPair(): Promise<{ sourceId: string; forkId: string; ownerId: number }> {
    const owner = (
      await db
        .insert(users)
        .values({ username: "alice", usernameLower: "alice", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") })
        .returning()
        .all()
    )[0];
    if (owner === undefined) throw new Error("user seed failed");
    const base = {
      ownerNamespace: "alice",
      ownerId: owner.id,
      visibility: "public" as const,
      refsVersion: 1,
      backend: "self-hosted" as const,
      createdAt: new Date("2026-02-03T04:05:06Z"),
    };
    const sourceId = "7401";
    const forkId = "7402";
    await db.insert(repositories).values([
      { ...base, id: sourceId, storageKey: `r_${sourceId}`, slug: "base", status: "ready", isEmpty: false },
      {
        ...base,
        id: forkId,
        storageKey: `r_${forkId}`,
        slug: "fork",
        status: "creating",
        forkParent: sourceId,
        defaultBranch: "trunk",
      },
    ]);
    return { sourceId, forkId, ownerId: owner.id };
  }

  async function forkRow(forkId: string) {
    const row = await db.select().from(repositories).where(eq(repositories.id, forkId)).get();
    if (row === undefined) throw new Error("fork seed failed");
    return row;
  }

  async function numForks(repoId: string): Promise<number> {
    const row = await db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (row === undefined) throw new Error("repo seed failed");
    return row.numForks;
  }

  it("the settle bumps the source's num_forks exactly once, in the same batch as the CAS (fork.go:110-113)", async () => {
    const { sourceId, forkId } = await seedForkPair();
    expect(await numForks(sourceId)).toBe(0);
    const settled = await settleForkRow(db, await forkRow(forkId), false, { countTowardSourceId: sourceId });
    expect(settled).toBe(true);
    expect(await numForks(sourceId)).toBe(1);
    expect((await forkRow(forkId)).status).toBe("ready");
  });

  it("a redelivery (fork already 'ready') moves neither the CAS nor the tally", async () => {
    const { sourceId, forkId } = await seedForkPair();
    await settleForkRow(db, await forkRow(forkId), false, { countTowardSourceId: sourceId });
    const settled = await settleForkRow(db, await forkRow(forkId), false, { countTowardSourceId: sourceId });
    expect(settled).toBe(false);
    expect(await numForks(sourceId)).toBe(1);
  });

  it("the generate path does NOT count — settleForkRow without the tally option leaves the parent at 0", async () => {
    // Upstream: GenerateRepository carries no IncrementRepoForkNum arm — a
    // generated copy has IsFork=false/ForkID=0; only ForkRepository bumps.
    const { sourceId, forkId } = await seedForkPair();
    const settled = await settleForkRow(db, await forkRow(forkId), false);
    expect(settled).toBe(true);
    expect((await forkRow(forkId)).status).toBe("ready");
    expect(await numForks(sourceId)).toBe(0);
  });

  it("a vanished source row makes the tally arm inert — the orphaned-shell settle rides through", async () => {
    const { forkId } = await seedForkPair();
    const settled = await settleForkRow(db, await forkRow(forkId), true, { countTowardSourceId: "gone" });
    expect(settled).toBe(true);
    expect((await forkRow(forkId)).status).toBe("ready");
  });

  it("renders as forks_count (convert/repository.go:220 — Forks: repo.NumForks)", async () => {
    const { sourceId, forkId } = await seedForkPair();
    await settleForkRow(db, await forkRow(forkId), false, { countTowardSourceId: sourceId });
    const pair = await findRepositoryById(env.DB, sourceId);
    if (pair === null) throw new Error("repo seed failed");
    const rendered = toApiRepository({ origin: "https://example.com", requester: null }, pair);
    expect(rendered.forks_count).toBe(1);
    expect(rendered.stars_count).toBe(0); // untouched by the fork settle
  });
});
