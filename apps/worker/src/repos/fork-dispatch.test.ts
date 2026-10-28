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
import { asc, eq } from "drizzle-orm";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { findRepositoryById, toApiRepository } from "../api/services/repository";
import { ZERO_OID } from "../api/services/engine";
import { handleForkMessage, settleForkRow } from "./fork-task";
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

// ---------------------------------------------------------------------------
// The `fork` event's DEDICATED DELIVERY ASSERTION (SPEC-0005 §3.5): the
// settle's winning invocation emits through emitRepoEventInline, whose
// fan-out writes webhook_deliveries rows for the SOURCE repository's hooks
// — upstream routes ForkRepository through EventSource{Repository: oldRepo}
// (services/webhook/notifier.go:92). The ForkPayload contract
// (modules/structs/hook.go:272-275) has exactly three fields — forkee,
// repository, sender, no action — and the NOTIFIER fills them against the
// struct's own doc comments: forkee = the SOURCE (oldRepo), repository =
// the new fork, sender = the creating doer (notifier.go:93-96; the fork
// route mints owner = caller, so the owner row IS the doer). The deliveries
// are asserted over the webhook_deliveries D1 rows (the delivery log IS the
// source of truth) — the wiki.test.ts house pattern. Migrations were
// applied by the tally describe's beforeAll (applyD1Migrations is
// idempotent; this describe re-applies defensively).
// ---------------------------------------------------------------------------

describe("REPO_TASKS fork settle webhook delivery (the fork event)", () => {
  let forkSeq = 0;

  beforeAll(async () => {
    if (env.TEST_MIGRATIONS === undefined) {
      throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
    }
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    for (const table of ["webhook_deliveries", "webhooks", "stars", "repositories", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  const db = drizzle(env.DB);

  const forkDeliveries = async (hookId: number): Promise<Array<typeof webhookDeliveries.$inferSelect>> =>
    db.select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).orderBy(asc(webhookDeliveries.id)).all();

  /** Active webhook with the given subscription config — the fan-out matcher target. */
  async function seedHook(repoId: string, config: Record<string, unknown>): Promise<number> {
    const rows = await db
      .insert(webhooks)
      .values({
        repoId,
        url: "https://hooks.invalid/fork-emissions-test",
        events: JSON.stringify(config),
        isActive: true,
        type: "gitea",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: webhooks.id })
      .all();
    const row = rows[0];
    if (row === undefined) throw new Error("hook seed failed");
    return row.id;
  }

  /** A one-commit source cell (loose, the auto_init shape) — the replication
   *  carries real content and the settle is non-empty. */
  async function seedSourceContent(ns: string, slug: string): Promise<void> {
    const cell = env.REPO.getByName(`${ns}/${slug}`);
    const blob = new TextEncoder().encode("# fork source\n");
    const blobOid = await looseOid("blob", blob);
    const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
    const person = { name: "seed", email: "seed@forks.invalid", time: 1761000000, tz: "+0000" };
    const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "seed\n" });
    const put = await cell.putApiObjects([
      { oid: blobOid, type: "blob", data: blob },
      { oid: tree.oid, type: "tree", data: tree.data },
      { oid: commit.oid, type: "commit", data: commit.data },
    ]);
    if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
    const landed = await cell.commitApiChange({ ref: "refs/heads/main", expectedOldOid: ZERO_OID, newOid: commit.oid });
    if (landed.tag !== "committed") throw new Error(`seed branch landing failed: ${landed.tag}`);
  }

  /** SHA-1 of one loose git object (header-prefixed). */
  async function looseOid(type: "blob", data: Uint8Array): Promise<string> {
    const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
    const bytes = new Uint8Array(header.byteLength + data.byteLength);
    bytes.set(header);
    bytes.set(data, header.byteLength);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Alice owns the source; Bob owns the fork (owner = caller, the forks
   *  route's mint) — three distinct payload subjects (alice/base,
   *  bob/fork, sender bob). Cells are keyed by NAME and outlive the D1
   *  wipe, so every test gets a fresh slug pair. */
  async function seedForkScenario(): Promise<{ sourceId: string; forkId: string; sourceSlug: string; forkSlug: string }> {
    forkSeq += 1;
    const sourceSlug = `base-${forkSeq}`;
    const forkSlug = `fork-${forkSeq}`;
    const inserted = await db
      .insert(users)
      .values([
        { username: "alice", usernameLower: "alice", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
        { username: "bob", usernameLower: "bob", status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
      ])
      .returning()
      .all();
    const alice = inserted[0];
    const bob = inserted[1];
    if (alice === undefined || bob === undefined) throw new Error("user seed failed");
    const base = {
      visibility: "public" as const,
      refsVersion: 1,
      backend: "self-hosted" as const,
      createdAt: new Date("2026-02-03T04:05:06Z"),
    };
    const rows = await db
      .insert(repositories)
      .values([
        {
          ...base,
          id: `810${forkSeq}0`,
          ownerNamespace: "alice",
          ownerId: alice.id,
          storageKey: `r_810${forkSeq}0`,
          slug: sourceSlug,
          status: "ready",
          isEmpty: false,
        },
        {
          ...base,
          id: `810${forkSeq}1`,
          ownerNamespace: "bob",
          ownerId: bob.id,
          storageKey: `r_810${forkSeq}1`,
          slug: forkSlug,
          status: "creating",
          forkParent: `810${forkSeq}0`,
          defaultBranch: "trunk",
        },
      ])
      .returning({ id: repositories.id })
      .all();
    const [source, fork] = rows;
    if (source === undefined || fork === undefined) throw new Error("repo seed failed");
    return { sourceId: source.id, forkId: fork.id, sourceSlug, forkSlug };
  }

  it("the winning settle emits `fork` exactly once through the SOURCE repo, ForkPayload upstream-shaped", async () => {
    const { sourceId, forkId, sourceSlug, forkSlug } = await seedForkScenario();
    await seedSourceContent("alice", sourceSlug);
    const forkHook = await seedHook(sourceId, { choose_events: true, branch_filter: "*", events: { fork: true } });
    const everythingHook = await seedHook(sourceId, { send_everything: true, branch_filter: "*" });
    const pushHook = await seedHook(sourceId, { choose_events: true, branch_filter: "*", events: { push: true } });

    await handleForkMessage(env, { kind: "repo-fork", sourceRepoId: sourceId, forkRepoId: forkId });

    const forkRow = await db.select({ status: repositories.status }).from(repositories).where(eq(repositories.id, forkId)).get();
    expect(forkRow?.status).toBe("ready"); // the emission's precondition

    const deliveries = await forkDeliveries(forkHook);
    expect(deliveries).toHaveLength(1); // exactly-once: one winning settle, one delivery
    const row = deliveries[0]!;
    expect([row.eventType, row.eventGroup]).toEqual(["fork", "fork"]); // HookEventFork.Event() = "fork"
    expect(row.repoId).toBe(sourceId); // EventSource = the SOURCE repository (notifier.go:92)
    // §2.7 serialization: 2-space MarshalIndent — forkee renders first.
    expect(row.payloadContent.startsWith('{\n  "forkee": ')).toBe(true);
    const payload = JSON.parse(row.payloadContent) as {
      forkee: { full_name: string };
      repository: { full_name: string };
      sender: { login: string };
    };
    // Exactly the three ForkPayload fields (hook.go:272-275 — no action key).
    expect(Object.keys(payload).sort()).toEqual(["forkee", "repository", "sender"]);
    // The struct field DOC is stale upstream; the NOTIFIER fills forkee with
    // the SOURCE (oldRepo) and repository with the new fork (notifier.go:93-95).
    expect(payload.forkee.full_name).toBe(`alice/${sourceSlug}`);
    expect(payload.repository.full_name).toBe(`bob/${forkSlug}`);
    // The fork owner IS the creating doer (the route mints owner = caller).
    expect(payload.sender.login).toBe("bob");

    // Subscription scoping: send_everything hears the same event; push-only
    // stays silent.
    const everything = await forkDeliveries(everythingHook);
    expect(everything).toHaveLength(1);
    expect(everything[0]!.eventType).toBe("fork");
    expect(await forkDeliveries(pushHook)).toHaveLength(0);
  });

  it("a redelivered settle emits nothing new — the emission is CAS-gated exactly-once with the settle", async () => {
    const { sourceId, forkId, sourceSlug } = await seedForkScenario();
    await seedSourceContent("alice", sourceSlug);
    const forkHook = await seedHook(sourceId, { choose_events: true, branch_filter: "*", events: { fork: true } });
    const msg = { kind: "repo-fork" as const, sourceRepoId: sourceId, forkRepoId: forkId };

    await handleForkMessage(env, msg);
    // The at-least-once replay: beginForkImport refuses (already finalized),
    // the settle CAS refuses (fork already 'ready') — no second emission.
    await handleForkMessage(env, msg);

    expect(await forkDeliveries(forkHook)).toHaveLength(1);
  });

  it("the source-vanished shell settles silently — nothing replicated, nothing emitted", async () => {
    const { sourceId, forkId } = await seedForkScenario();
    // Drop the source row: the orphaned-shell arm settles the fork
    // ready-empty WITHOUT the emission block (nothing was replicated).
    await db.delete(repositories).where(eq(repositories.id, sourceId));
    const forkHook = await seedHook(forkId, { choose_events: true, branch_filter: "*", events: { fork: true } });

    await handleForkMessage(env, { kind: "repo-fork", sourceRepoId: "gone", forkRepoId: forkId });

    const forkRow = await db.select({ status: repositories.status }).from(repositories).where(eq(repositories.id, forkId)).get();
    expect(forkRow?.status).toBe("ready");
    expect(await forkDeliveries(forkHook)).toHaveLength(0);
  });
});
