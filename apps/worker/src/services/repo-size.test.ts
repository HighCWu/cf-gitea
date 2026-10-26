/**
 * Settle-time repository size (services/repo-size.ts) — the `size_kb` column
 * and its two settle legs, over REAL bindings (real D1 + real R2 + real
 * engine DOs; the webhooks-push.test.ts integration pattern).
 *
 * Covered:
 *   - the R2 walk: prefix scoping (a sibling repo's prefix and the imports/
 *     channel stay out), cursor pagination (small pages), the page cap
 *     (degraded answer, never a hang) and the KiB floor (upstream's Go
 *     `int(size/1024)` truncation, convert/repository.go:207);
 *   - the persistence: size_kb lands WITHOUT bumping updated_at (upstream
 *     NoAutoTime, models/repo/update.go:108), 0 for an empty prefix;
 *   - the API render: `toApiRepository().size` IS the persisted column;
 *   - the push settle leg END-TO-END: a real gate push (real pack bytes into
 *     R2 packs/) through the entrypoint's exact engine composition — onPush
 *     fires the leg and the D1 row carries the settled KiB;
 *   - the direct adapter arm (handleUserPushEvent, the engine-native receive
 *     population) settles too;
 *   - the fork/generate settle leg: replicateRepoCopy re-accounts the FORK's
 *     own prefix (upstream fork.go:190 / generate.go:295).
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDurableGit } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { findRepositoryById, toApiRepository, type Viewer } from "../api/services/repository";
import { repositories, users } from "../db/schema";
import { gitHttpGate } from "../git-http/gate";
import { authorize } from "../git-http/authorize";
import { RepoService, type RepoRow } from "../repos/service";
import { buildPack, buildReceivePackBody, ZERO_OID } from "../repos/testing/git-pack";
import { replicateRepoCopy } from "../repos/fork-task";
import {
  bytesToKib,
  repoStoragePrefix,
  REPO_SIZE_MAX_LIST_PAGES,
  sumRepoStorageBytes,
  syncRepoSizeFromStorage,
  type RepoSizeBucket,
} from "./repo-size";
import { handleUserPushEvent } from "./webhooks-push";

// ---------------------------------------------------------------------------
// The engine under test — the entrypoint wiring's exact composition
// (webhooks-push.test.ts's pattern): gate → engine with the onPush seam
// wired to the adapter, so the receive → finalize → onPush → settle path is
// the production path.
// ---------------------------------------------------------------------------

const wiredEngine = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: (event, env2) => handleUserPushEvent(env2, event),
});

/** ExecutionContext stub with a collecting waitUntil sink (webhooks-push
 *  .test.ts's NoopSpan shape, trimmed to what the gate path touches). */
class NoopSpan {
  get isTraced(): boolean {
    return false;
  }
  spanContext(): TracingSpanContext {
    return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }
  setAttribute(_key: string, _value: boolean | number | string): this {
    return this;
  }
  setAttributes(_attributes: Record<string, boolean | number | string | undefined>): this {
    return this;
  }
  recordException(
    _exception: string | { code: string | number; name?: string; message?: string; stack?: string },
  ): void {}
  updateName(_name: string): this {
    return this;
  }
  setStatus(_status: TracingSpanStatus): this {
    return this;
  }
  end(): void {}
}

const EXPORTS_HOLE = undefined as never;
const pendingWaits: Promise<unknown>[] = [];
const ctx: ExecutionContext = {
  waitUntil: (promise) => {
    pendingWaits.push(Promise.resolve(promise));
  },
  passThroughOnException: () => {},
  abort: () => {},
  exports: EXPORTS_HOLE,
  props: undefined,
  tracing: {
    enterSpan: <T, A extends unknown[]>(_name: string, callback: (span: NoopSpan, ...args: A) => T, ...args: A): T =>
      callback(new NoopSpan(), ...args),
    startActiveSpan: <T, A extends unknown[]>(
      _name: string,
      callback: (span: NoopSpan, ...args: A) => T,
      ...args: A
    ): T => callback(new NoopSpan(), ...args),
    startSpan: (_name: string) => new NoopSpan(),
    getActiveSpan: () => undefined,
    Span: NoopSpan,
  },
};

async function drainWaits(): Promise<void> {
  for (let round = 0; round < 10 && pendingWaits.length > 0; round++) {
    const batch = pendingWaits.splice(0, pendingWaits.length);
    await Promise.allSettled(batch);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["personal_access_tokens", "repo_units", "repo_transfer", "repo_redirects", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

/** A ready D1 repo owned by a fresh user; the storage key is minted r_<id>. */
async function seedRepo(name: string): Promise<RepoRow> {
  const user = await seedVerifiedUser({ username: `Size-${name}` });
  const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
  return service.create({
    owner: { id: user.id, usernameLower: user.username.toLowerCase() },
    name,
    isPrivate: false,
  });
}

/** N objects of `bytes` each under the repo's packs/ prefix, via real R2.
 *  `startIdx` keeps object names distinct across calls (append, not overwrite). */
async function putPackObjects(repo: RepoRow, count: number, bytes: number, startIdx = 0): Promise<number> {
  const payload = new Uint8Array(bytes);
  for (let i = 0; i < count; i++) {
    await env.REPO_PACKS.put(repoStoragePrefix(repo.storageKey) + `packs/pack-${startIdx + i}.pack`, payload);
  }
  return count * bytes;
}

/** The fresh D1 row (the settle legs write, tests re-read). */
async function repoRow(id: string): Promise<RepoRow> {
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, id)).get();
  if (!row) throw new Error(`repo row ${id} missing`);
  return row;
}

// ---------------------------------------------------------------------------
// The R2 walk (unit over real R2 + a stub for the cap)
// ---------------------------------------------------------------------------

describe("sumRepoStorageBytes — the R2 byte accounting", () => {
  it("sums the repo's own prefix across paginated pages; sibling and imports/ prefixes stay out", async () => {
    const repo = await seedRepo("walk");
    const other = await seedRepo("walk-sibling");

    // The repo's footprint: packs/ + idx + staging (the git-dir equivalents).
    const big = new Uint8Array(2000);
    const small = new Uint8Array(100);
    const tiny = new Uint8Array(24);
    await env.REPO_PACKS.put(repoStoragePrefix(repo.storageKey) + "packs/pack-a.pack", big);
    await env.REPO_PACKS.put(repoStoragePrefix(repo.storageKey) + "packs/pack-a.idx", small);
    await env.REPO_PACKS.put(repoStoragePrefix(repo.storageKey) + "staging/pack-rx-lease.pack", tiny);
    // Noise that must NOT count: another repo's prefix + the import channel's
    // transient chunk staging (purged at import end, never the live git dir).
    await env.REPO_PACKS.put(repoStoragePrefix(other.storageKey) + "packs/pack-z.pack", big);
    await env.REPO_PACKS.put(`imports/${repo.storageKey}/7/chunk-0`, big);

    // pageLimit 2 forces real cursor pagination over the 3 objects.
    const total = await sumRepoStorageBytes(env.REPO_PACKS, repo.storageKey, { pageLimit: 2 });
    expect(total).toBe(2124);
    expect(await sumRepoStorageBytes(env.REPO_PACKS, other.storageKey)).toBe(2000);
  });

  it("answers 0 for an unstored prefix and for a missing bucket", async () => {
    const repo = await seedRepo("walkempty");
    await expect(sumRepoStorageBytes(env.REPO_PACKS, repo.storageKey)).resolves.toBe(0);
    await expect(sumRepoStorageBytes(undefined, "r_whatever")).resolves.toBe(0);
  });

  it("degrades at the page cap instead of hanging (always-truncated stub)", async () => {
    // A hostile bucket that never reports !truncated: the walk must stop at
    // REPO_SIZE_MAX_LIST_PAGES and return what it summed — the documented
    // degraded answer, not a throw and not an infinite loop.
    const calls = { n: 0 };
    const hostile: RepoSizeBucket = {
      list: () => {
        calls.n++;
        return Promise.resolve({ objects: [{ size: 10 }], truncated: true, cursor: "next" });
      },
    };
    const total = await sumRepoStorageBytes(hostile, "r_cap");
    expect(calls.n).toBe(REPO_SIZE_MAX_LIST_PAGES);
    expect(total).toBe(10 * REPO_SIZE_MAX_LIST_PAGES);
  });
});

describe("bytesToKib — upstream's KB render unit", () => {
  it("floors like Go's int(size / 1024)", () => {
    expect(bytesToKib(0)).toBe(0);
    expect(bytesToKib(1023)).toBe(0);
    expect(bytesToKib(1024)).toBe(1);
    expect(bytesToKib(2124)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence + API render
// ---------------------------------------------------------------------------

describe("syncRepoSizeFromStorage — the settle persistence", () => {
  it("persists the floored KiB without bumping updated_at; 0 for an empty repo", async () => {
    const repo = await seedRepo("settle");
    // An empty prefix settles 0 (the empty-repo answer) and leaves the row's
    // updated_at untouched (upstream NoAutoTime, update.go:108).
    const before = new Date(1700000000000);
    await drizzle(env.DB).update(repositories).set({ updatedAt: before }).where(eq(repositories.id, repo.id)).run();

    await syncRepoSizeFromStorage(env.REPO_PACKS, env.DB, repo);
    let settled = await repoRow(repo.id);
    expect(settled.sizeKb).toBe(0);
    expect(settled.updatedAt?.getTime()).toBe(before.getTime());

    const total = await putPackObjects(repo, 3, 1024);
    await syncRepoSizeFromStorage(env.REPO_PACKS, env.DB, repo);
    settled = await repoRow(repo.id);
    expect(settled.sizeKb).toBe(bytesToKib(total)); // 3
    expect(settled.updatedAt?.getTime()).toBe(before.getTime());
  });

  it("the API payload's size IS the persisted column (toApiRepository render)", async () => {
    const repo = await seedRepo("render");
    await putPackObjects(repo, 1, 1536); // 1.5 KiB → floor 1
    await syncRepoSizeFromStorage(env.REPO_PACKS, env.DB, repo);

    const pair = await findRepositoryById(env.DB, repo.id);
    expect(pair).not.toBeNull();
    const viewer: Viewer = { origin: "https://example.com", requester: null };
    const payload = toApiRepository(viewer, pair!);
    expect(payload.size).toBe(1);

    // Push more bytes, re-settle, the render follows the column.
    await putPackObjects(repo, 2, 2048, 1);
    await syncRepoSizeFromStorage(env.REPO_PACKS, env.DB, repo);
    const payload2 = toApiRepository(viewer, (await findRepositoryById(env.DB, repo.id))!);
    expect(payload2.size).toBe(bytesToKib(1536 + 2 * 2048)); // 5
  });
});

// ---------------------------------------------------------------------------
// The push settle leg (the onPush seam wiring)
// ---------------------------------------------------------------------------

describe("the push settle leg — real bytes through the entrypoint composition", () => {
  const RECEIVE_CT = "application/x-git-receive-pack-request";
  const ORIGIN = "https://example.com";

  it("a real gate push persists the settled size (pack bytes → onPush → size_kb)", async () => {
    const repo = await seedRepo("pushed");
    const owner = await drizzle(env.DB).select().from(users).where(eq(users.id, repo.ownerId!)).get();
    const token = (await mintFor(owner!.id, "size-write", "write:repository")).plaintext;

    // size_kb starts at the column default (0) — the empty-repo answer.
    expect((await repoRow(repo.id)).sizeKb).toBe(0);

    const { oid, pack } = await buildPack();
    const base = `${ORIGIN}/${repo.ownerNamespace}/${repo.slug}.git`;
    const advert = await gitHttpGate(
      new Request(`${base}/info/refs?service=git-receive-pack`, { headers: { authorization: basicTokenHeader(token) } }),
      env,
      ctx,
      wiredEngine,
    );
    expect(advert.status).toBe(200);
    const response = await gitHttpGate(
      new Request(`${base}/git-receive-pack`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
        body: buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack),
      }),
      env,
      ctx,
      wiredEngine,
    );
    expect(response.status).toBe(200);
    await drainWaits(); // the onPush seam's settle legs

    // The receive put real bytes into R2 (pack + idx + clone cache); the
    // settle leg accounted them into the column without any direct call.
    const settled = await repoRow(repo.id);
    const expected = await sumRepoStorageBytes(env.REPO_PACKS, repo.storageKey);
    expect(expected).toBeGreaterThan(0);
    expect(settled.sizeKb).toBe(bytesToKib(expected));
    expect(settled.sizeKb).toBeGreaterThan(0);
  });

  it("the adapter arm settles too (handleUserPushEvent, engine-native receive shape)", async () => {
    const repo = await seedRepo("native");
    await putPackObjects(repo, 4, 1024);
    await handleUserPushEvent(env, {
      repo: `${repo.ownerNamespace}/${repo.slug}`,
      updates: [{ ref: "refs/heads/main", old: ZERO_OID, new: "c".repeat(40) }],
      commitTime: 0,
    });
    expect((await repoRow(repo.id)).sizeKb).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The fork/generate settle leg (replicateRepoCopy)
// ---------------------------------------------------------------------------

describe("the fork settle leg — replicateRepoCopy re-accounts the fork's own prefix", () => {
  it("a settled fork carries its copied footprint (generate rides the same pass)", async () => {
    const source = await seedRepo("forksrc");
    const fork = await seedRepo("forkdst");
    expect((await repoRow(fork.id)).sizeKb).toBe(0);

    // The fork's copied packs — with an empty source the replication moves
    // nothing, so these bytes stand in for the footprint the copy lands (the
    // accounting must describe the FORK's own prefix, never the source's).
    const total = await putPackObjects(fork, 5, 1024);

    await replicateRepoCopy(env, source, fork);

    const settled = await repoRow(fork.id);
    expect(settled.sizeKb).toBe(bytesToKib(total)); // 5 — inherited, from its own bytes
  });

  it("an empty fork settles 0", async () => {
    const source = await seedRepo("emptysrc");
    const fork = await seedRepo("emptydst");
    await replicateRepoCopy(env, source, fork);
    expect((await repoRow(fork.id)).sizeKb).toBe(0);
  });
});
