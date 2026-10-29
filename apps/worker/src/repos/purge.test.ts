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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { repoRedirects, repositories, users } from "../db/schema";
import type { RepositoryRow, RepositoryWithOwner } from "../api/services/repository";
import { createWikiPage, readWikiPage } from "../services/wiki";
import { handleRepoTasks, purgeRepoMessage } from "./purge";
import { RepoService } from "./service";
import { ZERO_OID } from "./testing/git-pack";

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

// ---------------------------------------------------------------------------
// SPEC-0014 §3.2 — the demo-sweep arm: {kind: "demo-sweep", repoId} drives
// the EXISTING deleteRepository cascade (the API DELETE route's own path),
// with the consume-time exemption/age re-check and the idempotent acks. The
// producer/gate side lives in src/services/demo-sweep.test.ts (the §2
// gate-off invariant battery runs there, first).
//
// The cascade itself is NOT re-tested here (repos/lifecycle.test.ts pins
// deleteRepository); the sweep's assertions stop at "the right function ran
// for the right row" plus end-state row absence (SPEC-0014 §7).
// ---------------------------------------------------------------------------

/** Recording REPO_TASKS (the demo-sweep.test.ts shape, local copy per the
 *  test-file-copy precedent): captures the cascade's step-3 purge message. */
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

const totalSends = (queue: ReturnType<typeof spyQueue>): number => queue.sends + queue.sendBatchCalls;

/** The gate-off tripwire (demo-sweep.test.ts copy): a D1 stub that throws on
 *  first touch — used here to force a real error THROUGH the arm's retry
 *  path without module mocks. */
function d1ThatThrows(): D1Database {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`D1 stub: .${String(prop)} (forced throw)`);
      },
    },
  ) as D1Database;
}

async function resetD1(): Promise<void> {
  // Storage isolation resets D1 between tests (apply-d1-migrations.ts
  // header) — re-apply, then wipe defensively anyway.
  await applyAuthD1Migrations();
  for (const table of ["repo_mirrors", "push_mirrors", "repo_counters", "repositories", "repo_redirects"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users").run();
}

async function seedUser(id: number, username: string, opts: { isAdmin?: boolean } = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', 'user', 0)",
  )
    .bind(id, username, username, opts.isAdmin === true ? 1 : 0)
    .run();
}

async function seedSweepRepo(id: string, ownerId: number): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: `owner-${id}`,
    ownerId,
    slug: `repo-${id}`,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date(0), // epoch — far past the 72 h retention cut
  });
}

const repoRowExists = async (id: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT id FROM repositories WHERE id = ?").bind(id).first()) !== null;

describe("demo-sweep consumer arm (SPEC-0014 §3.2)", () => {
  beforeEach(resetD1);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drives the EXISTING deleteRepository cascade: row gone, redirects cleared, the standard purge message enqueued", async () => {
    await seedUser(80, "swept-owner");
    await seedSweepRepo("8001", 80);
    // A redirect pointing AT the repo — the cascade must clear it and carry
    // the redirected engine name in the purge message.
    await drizzle(env.DB).insert(repoRedirects).values({
      ownerId: 80,
      ownerNamespace: "owner-8001",
      lowerName: "old-name",
      redirectRepoId: "8001",
    });
    const queue = spyQueue();
    const { batch, acked, retried } = fabricatedBatch([{ id: "sweep-1", body: { kind: "demo-sweep", repoId: "8001" } }]);

    await handleRepoTasks(batch, { ...env, REPO_TASKS: queue });

    expect(acked).toEqual(["sweep-1"]);
    expect(retried).toEqual([]);
    expect(await repoRowExists("8001")).toBe(false);
    expect(await drizzle(env.DB).select().from(repoRedirects).all()).toEqual([]);
    // The cascade's step 3: the EXACT standard purge message (no demo
    // variant) — current + redirected engine names, the storage key.
    expect(queue.sendBodies).toEqual([
      { storageKey: "r_8001", engineNames: ["owner-8001/repo-8001", "owner-8001/old-name"] },
    ]);
  });

  it("re-checks the exemption at consume time: owner promoted to admin since enqueue → ack, no delete (§6.3)", async () => {
    await seedUser(80, "promoted");
    await seedSweepRepo("8002", 80);
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = 80").run();
    const queue = spyQueue();
    const { batch, acked, retried } = fabricatedBatch([{ id: "sweep-2", body: { kind: "demo-sweep", repoId: "8002" } }]);

    await handleRepoTasks(batch, { ...env, REPO_TASKS: queue });

    expect(acked).toEqual(["sweep-2"]);
    expect(retried).toEqual([]);
    expect(await repoRowExists("8002")).toBe(true); // exemption is a property of the owner NOW
    expect(totalSends(queue)).toBe(0); // no cascade ran, no purge message
  });

  it("acks a sweep for a repo a user already deleted — no error, no retry (§6.6)", async () => {
    await seedUser(80, "owner");
    const queue = spyQueue();
    const { batch, acked, retried } = fabricatedBatch([
      { id: "sweep-3", body: { kind: "demo-sweep", repoId: "never-created" } },
    ]);

    await handleRepoTasks(batch, { ...env, REPO_TASKS: queue });

    expect(acked).toEqual(["sweep-3"]);
    expect(retried).toEqual([]);
    expect(totalSends(queue)).toBe(0);
  });

  it("absorbs a duplicate message idempotently: first deletes, second finds the row gone and acks (§6.7)", async () => {
    await seedUser(80, "owner");
    await seedSweepRepo("8004", 80);
    const queue = spyQueue();

    const first = fabricatedBatch([{ id: "sweep-4a", body: { kind: "demo-sweep", repoId: "8004" } }]);
    await handleRepoTasks(first.batch, { ...env, REPO_TASKS: queue });
    expect(first.acked).toEqual(["sweep-4a"]);
    expect(await repoRowExists("8004")).toBe(false);

    // The double-enqueued twin (same repo enqueued twice across a tick
    // boundary while the purge was still draining) — row-deletion was the
    // claim, so the second message is a plain ack.
    const second = fabricatedBatch([{ id: "sweep-4b", body: { kind: "demo-sweep", repoId: "8004" } }]);
    await handleRepoTasks(second.batch, { ...env, REPO_TASKS: queue });
    expect(second.acked).toEqual(["sweep-4b"]);
    expect(second.retried).toEqual([]);
  });

  it("a throw retries THAT message with the [repo-tasks] demo-sweep log line (the §3.0 DLQ's upstream)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { batch, acked, retried } = fabricatedBatch([
      { id: "sweep-err", body: { kind: "demo-sweep", repoId: "8005" } },
    ]);

    // The tripwire DB: the arm's first D1 read (RepoService.get) throws for
    // real — no module mocks — and that throw must surface as a RETRY plus
    // the family's observability line, never a silent drop.
    await handleRepoTasks(batch, { ...env, DB: d1ThatThrows() });

    expect(retried).toEqual(["sweep-err"]);
    expect(acked).toEqual([]);
    const lines = consoleError.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.some((line) => line.includes("[repo-tasks] demo-sweep sweep-err retrying"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The wiki purge cascade (specs/wiki.md §3 sibling cell — the spec-ledger
// follow-up): deleting a repo purges the main cell + storage, and the wiki
// family's SIBLING engine cell `<owner>/<slug>.wiki` (services/wiki.ts
// wikiCellName — upstream's `{repo}.wiki` sibling repo) must get the same
// treatment. Upstream parity: services/repository/delete.go:335-337 removes
// the wiki repo files in the same post-transaction sweep as the repo files.
//
// The wiki cell's whole state surface is the DO itself — its writes ride
// direct cell RPCs, so no R2 prefix, no D1 row and no engine-registry row
// exist for it (purge.ts module doc) — so the assertions stop at the cell:
// content GONE (a tombstone-only cell keeps answering reads, so empty refs
// prove destroy ran) and no tombstone flag left (beginReceive answers ok on
// the re-initialized empty cell). The wiki page is seeded through the LANDED
// service (createWikiPage), so the purge and the write path meet at the same
// naming convention the spec ledger flagged.
// ---------------------------------------------------------------------------

/** The repo+owner pair the wiki service ops take (seed-wiki.ts loadPair shape). */
async function wikiPairFor(repo: RepositoryRow, ownerId: number): Promise<RepositoryWithOwner> {
  const owner = await drizzle(env.DB).select().from(users).where(eq(users.id, ownerId)).get();
  if (owner === undefined) throw new Error(`wiki cascade test: owner row missing: ${ownerId}`);
  return { repo, owner };
}

/** One wiki page through the LANDED write path — provisions the sibling cell
 *  under the pinned write stamp (deterministic, wall-clock independent). */
async function seedWikiPage(repo: RepositoryRow, ownerId: number, doer: string, title: string): Promise<void> {
  await createWikiPage(
    env,
    await wikiPairFor(repo, ownerId),
    { name: doer, email: `${doer}@example.com` },
    { title, content: new TextEncoder().encode(`# ${title}\n`), message: "" },
    "https://example.com",
    { now: 1_700_000_000 },
  );
}

/** Ref names of one engine cell (the content probe: refs are the only roots). */
async function cellRefNames(engineName: string): Promise<string[]> {
  return (await env.REPO.getByName(engineName).listRefs()).refs.map((ref) => ref.name);
}

/** The cell carries no tombstone flag: beginReceive answers ok on the
 *  re-initialized empty cell (the lifecycle delete test's revived probe). */
async function expectNoTombstone(engineName: string): Promise<void> {
  const begin = await env.REPO.getByName(engineName).beginReceive({
    commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
    capabilities: [],
    packBytesHint: null,
  });
  expect(begin.tag).toBe("ok");
  if (begin.tag === "ok") {
    await env.REPO.getByName(engineName).releaseReceive({ leaseToken: begin.leaseToken, sweep: false });
  }
}

describe("repo delete purge wiki cascade (specs/wiki.md §3 sibling cell)", () => {
  beforeEach(resetD1);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("purges the wiki sibling cell with the main cell — no orphan remains, redelivery idempotent", async () => {
    await seedUser(90, "alice");
    const repo = await new RepoService(env.DB).create({
      owner: { id: 90, usernameLower: "alice" },
      name: "doomed",
      isPrivate: false,
    });
    await seedWikiPage(repo, 90, "alice", "Home");

    // Main-cell surroundings (the lifecycle delete test's seeding): R2 under
    // the immutable storage key + a registry row the engine 404s against.
    await env.REPO_PACKS.put(`repos/${repo.storageKey}/packs/pack-x.pack`, new Uint8Array([1, 2, 3]));
    await env.REPO_PACKS.put(`imports/${repo.storageKey}/chunk-0.pack`, new Uint8Array([4]));
    await env.REGISTRY.getByName("registry").upsert("alice/doomed", Date.now());

    // Producer sanity: the sibling cell is LIVE under the wiki convention —
    // the page write seated refs/heads/main (the repo's default branch).
    expect(await cellRefNames("alice/doomed.wiki")).toEqual(["refs/heads/main"]);

    const body = { storageKey: repo.storageKey, engineNames: ["alice/doomed"] };
    await purgeRepoMessage(env, body);

    // The main arm is unchanged: R2 prefixes swept, registry row gone, the
    // main cell destroyed (re-initialized empty — no tombstone flag).
    expect((await env.REPO_PACKS.list({ prefix: `repos/${repo.storageKey}/` })).objects).toHaveLength(0);
    expect((await env.REPO_PACKS.list({ prefix: `imports/${repo.storageKey}/` })).objects).toHaveLength(0);
    expect(await env.REGISTRY.getByName("registry").get("alice/doomed")).toBeNull();
    await expectNoTombstone("alice/doomed");

    // THE CASCADE: the wiki cell is wiped, not tombstoned — refs gone (a
    // tombstone-only cell still answers reads) and no deleted flag left.
    expect(await cellRefNames("alice/doomed.wiki")).toEqual([]);
    await expectNoTombstone("alice/doomed.wiki");
    // The landed read path agrees: the purged cell answers the empty wiki.
    expect(await readWikiPage(env, await wikiPairFor(repo, 90), "Home", "https://example.com")).toBeNull();

    // Queue redelivery re-runs every idempotent step cleanly.
    await purgeRepoMessage(env, body);
    expect(await cellRefNames("alice/doomed.wiki")).toEqual([]);
    expect((await env.REPO_PACKS.list({ prefix: `repos/${repo.storageKey}/` })).objects).toHaveLength(0);
    await expectNoTombstone("alice/doomed.wiki");
  });

  it("a repo that never provisioned a wiki purges cleanly, and a renamed repo's stranded pre-rename wiki cell is reclaimed too", async () => {
    await seedUser(91, "bob");
    const svc = new RepoService(env.DB);
    const repo = await svc.create({ owner: { id: 91, usernameLower: "bob" }, name: "plain", isPrivate: false });
    // The pre-rename world: a page written at bob/plain.wiki.
    await seedWikiPage(repo, 91, "bob", "Old");
    expect(await cellRefNames("bob/plain.wiki")).toEqual(["refs/heads/main"]);

    // Rename — moveEngineCell carries only the MAIN cell, so bob/plain.wiki
    // is the stranded-orphan shape this sweep exists to reclaim — then a
    // post-rename page provisions the NEW sibling at the current name.
    await svc.rename(repo.id, "renamed");
    const renamed = (await svc.get(repo.id))!;
    await seedWikiPage(renamed, 91, "bob", "New");
    expect(await cellRefNames("bob/renamed.wiki")).toEqual(["refs/heads/main"]);

    // The REAL cascade's engineNames (current + redirected) drive the purge.
    const { engineNames } = await svc.deleteRepository(repo.id);
    expect(engineNames.sort()).toEqual(["bob/plain", "bob/renamed"].sort());
    await purgeRepoMessage(env, { storageKey: renamed.storageKey, engineNames });

    // Both wiki cells wiped — the live one AND the pre-rename orphan.
    expect(await cellRefNames("bob/renamed.wiki")).toEqual([]);
    expect(await cellRefNames("bob/plain.wiki")).toEqual([]);
    await expectNoTombstone("bob/renamed.wiki");
    await expectNoTombstone("bob/plain.wiki");

    // The never-provisioned arm: a repo with no wiki cell at all — the
    // derived name is re-initialized empty and destroyed, no throw.
    const bare = await svc.create({ owner: { id: 91, usernameLower: "bob" }, name: "bare", isPrivate: false });
    await purgeRepoMessage(env, { storageKey: bare.storageKey, engineNames: ["bob/bare"] });
    expect(await cellRefNames("bob/bare.wiki")).toEqual([]);
    await expectNoTombstone("bob/bare.wiki");
  });
});
