/**
 * Repository invariants checker — test battery.
 *
 * Real D1 + real R2 + real engine DOs (workerd, @cloudflare/vitest-plugin).
 * Repos are seeded through the real service + git-receive-pack pipeline
 * (SELF.fetch), so the packs under test are genuine engine output; violations
 * are INJECTED by deleting the R2 pack objects a ref's closure needs, which
 * is exactly the failure class the checker must catch through the public
 * read path. The catalog half runs against the engine's real listPackCatalog
 * RPC (read-only, lease-free) — the pack_catalog ↔ R2 cross-check needs no
 * eviction choreography at all: catalog rows and R2 objects are read
 * directly, so a deleted pack is catalog-pack-missing immediately, even when
 * the DO's object cache still serves the ref tips whose bytes died with it
 * (see check.ts "Detection horizon").
 *
 * Cache-warmth determinism (verified empirically, see check.ts "Detection
 * horizon"): a ref update peels its target, so every pushed TIP commit is
 * inflated into the DO's lifetime object cache and its pack's raw chunk into
 * a 4-slot chunk LRU — deleting a tip's pack is invisible to READS within
 * the same DO instance. Trees, blobs, and commits that were never ref tips
 * read through to R2, and their pack chunks are evicted after ~4 subsequent
 * pushes. The fixtures exploit exactly that — each walk fixture is the
 * MINIMUM push count that still puts its deletion target's chunk outside
 * the 4-slot LRU (4 pack uploads after the target, one chunk inserted per
 * push):
 *
 *   evictRepo — 6 create-pushes; pack1 needs 4 later inserts (pack2 + 3
 *   fillers) to go cold:
 *     packR  = {blobR, treeR, commitR}                 → refs/heads/root
 *     pack1  = {commitA→R, commitB→A} (treeR reused)   → refs/heads/base
 *     pack2  = {blob2, tree2, commitC1→B}              → refs/heads/main
 *     pack3-5 = three filler root commits              → refs/heads/filler1-3
 *   refs/heads/base is deleted afterwards (its tip B must not be walked —
 *   its TREE lives in the deleted pack and would add a tree-missing), and
 *   HEAD is re-pointed at main (the first-pushed branch is adopted as HEAD).
 *
 *   treeRepo — same chain, 6 create-pushes: the root and base closures ride
 *   ONE pack (two create-updates), so the deletion target pack2 lands at
 *   push 2 and the same four later inserts (f1-f4) evict it:
 *     packRB = {blobR, treeR, root, A, B}              → refs/heads/root+base
 *     pack2  = {blob2, tree2, commitC1→B}              → refs/heads/main
 *     pack3-6 = four filler root commits               → refs/heads/filler1-4
 *
 *   - deleting pack1 ⇒ closure-broken at A (never a ref tip → cache-cold)
 *   - deleting pack2 ⇒ tree-missing at C1's tree2 (tree/blob reads are cold)
 *   Tip-level faults (ref-tip-missing on a pushed tip) stay masked by the
 *   object cache — that classification is covered by a stubbed-RPC unit test
 *   below, and the real-world bound is documented in check.ts. The same mask
 *   applies to ANY object a push settle leg reads: default-branch settle legs
 *   (license sync) inflate the default branch's tree at push time, so
 *   both fixtures point D1's defaultBranch at the root push (see there).
 */

import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { repositories, users } from "../db/schema";
import { RepoService } from "../repos/service";
import { checkRepoInvariants, type InvariantsEnv, type InvariantReport } from "./check";
import type { CommitJson, PackCatalogEntry } from "@cf-gitea/git-engine";
import {
  enumerateRepos,
  enqueueInvariantChecks,
  handleInvariantCheckMessage,
  isInvariantCheckMessage,
} from "./run-all";
import {
  blobObject,
  buildPushBody,
  commitObject,
  commitPack,
  packOf,
  treeObject,
  type PushUpdate,
} from "./testing/git-push";

// wave-129 full-run contention budget: this file's heaviest closure measured
// 8.58s of the 30s default IN a green 8-worker full run (the injected-violation
// eviction walks — nine closures land in the 4-8.6s band; the suite's
// 260-isolate spawn storm spikes closures up to ~12x their solo time).
// File-local 90s budgets; vitest.config.ts keeps 30s for every other file.
// Membership: the measured >=4s in-run closure/hook set (full-suite junit
// run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "personal_access_tokens",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const RECEIVE_CT = "application/x-git-receive-pack-request";
const T0 = 1700000000;

/** Tests create several repos per case: the owner user is seeded once and
 *  reused (username_lower is UNIQUE), tokens get per-repo names. */
async function createRepo(slug: string): Promise<{ storageKey: string; repoId: string; token: string }> {
  const existing = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "alice"))
    .get();
  const aliceId = existing?.id ?? (await seedVerifiedUser({ username: "Alice" })).id;
  const repo = await new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") }).create({
    owner: { id: aliceId, usernameLower: "alice" },
    name: slug,
    isPrivate: false,
  });
  const token = (await mintFor(aliceId, `w-${slug}`, "write:repository")).plaintext;
  return { storageKey: repo.storageKey, repoId: repo.id, token };
}

/** One receive-pack round-trip exactly as a real git client runs it: the
 *  advert GET first (the engine's `meta.repo`/R2 binding is set by the first
 *  HTTP request — "the advert always precedes a push"), then the POST. */
async function pushSlug(slug: string, token: string, updates: PushUpdate[], pack: Uint8Array): Promise<void> {
  const advert = await SELF.fetch(`https://example.com/alice/${slug}/info/refs?service=git-receive-pack`, {
    headers: { authorization: basicTokenHeader(token) },
  });
  expect(advert.status).toBe(200);
  const res = await SELF.fetch(`https://example.com/alice/${slug}/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: buildPushBody(updates, pack),
  });
  expect(res.status).toBe(200);
  const report = new TextDecoder().decode(await res.arrayBuffer());
  expect(report).toContain("unpack ok");
  expect(report).not.toContain("ng ");
}

async function packKeySet(storageKey: string): Promise<Set<string>> {
  const listed = await env.REPO_PACKS.list({ prefix: `repos/${storageKey}/packs/` });
  return new Set(listed.objects.filter((o) => o.key.endsWith(".pack")).map((o) => o.key));
}

/** The one .pack key a push added (snapshot diff — pack names are content
 *  digests, so "latest uploaded" is not a reliable identifier). */
async function addedPackKey(before: Set<string>, storageKey: string): Promise<string> {
  const after = await packKeySet(storageKey);
  const added = [...after].filter((key) => !before.has(key));
  expect(added).toHaveLength(1);
  return added[0]!;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ThreePackRepo {
  storageKey: string;
  token: string;
  target: { engineName: string; storageKey: string };
  oids: { a: string; b: string; c: string };
  treeB: string;
  packs: { p1: string; p2: string; p3: string };
}

/** Three one-commit packs on a chain, one surviving ref (see the injection
 *  history in check.ts tests). Used where cache-warmth is irrelevant:
 *  healthy walks, budgets, staging probes. */
async function threePackRepo(slug: string): Promise<ThreePackRepo> {
  const { storageKey, token } = await createRepo(slug);
  const target = { engineName: `alice/${slug}`, storageKey };
  const stub = env.REPO.getByName(target.engineName);

  const a = await commitPack("a", [], [{ name: "a.txt", content: "one" }], T0);
  await pushSlug(slug, token, [{ ref: "refs/heads/base", oid: a.oid }], a.pack);
  const p1 = await addedPackKey(new Set(), storageKey);

  const b = await commitPack("b", [a.oid], [{ name: "b.txt", content: "two" }], T0 + 1);
  await pushSlug(slug, token, [{ ref: "refs/heads/mid", oid: b.oid }], b.pack);
  const p2 = await addedPackKey(new Set([p1]), storageKey);

  const c = await commitObject(b.treeOid, [b.oid], "c", T0 + 2);
  await pushSlug(slug, token, [{ ref: "refs/heads/main", oid: c.oid }], await packOf([c]));
  const p3 = await addedPackKey(new Set([p1, p2]), storageKey);

  // HEAD was adopted to the first-pushed branch (base); deleting base and
  // mid leaves main — re-point HEAD so the fixture itself stays invariant.
  // Both deletes ride the engine seam (deleteApiRef), not the gate/API: the
  // 8207da9 verdict's default-branch refusal (hook_pre_receive.go:141) lives
  // in those policy layers only, so deleting the first-pushed branch here is
  // not the upstream-invalid user path that verdict reshaped.
  expect((await stub.deleteApiRef({ ref: "refs/heads/base", expectedOid: a.oid })).tag).toBe("deleted");
  expect((await stub.deleteApiRef({ ref: "refs/heads/mid", expectedOid: b.oid })).tag).toBe("deleted");
  expect((await stub.setHead("main")).tag).toBe("ok");

  return {
    storageKey,
    token,
    target,
    oids: { a: a.oid, b: b.oid, c: c.oid },
    treeB: b.treeOid,
    packs: { p1, p2, p3 },
  };
}

interface EvictRepo {
  storageKey: string;
  token: string;
  target: { engineName: string; storageKey: string };
  oids: { root: string; a: string; b: string; c1: string };
  treeC1: string;
  packs: { packRoot: string; pack1: string; pack2: string };
}

/** The six-push fixture from the module docstring: pack1's chunk is
 *  LRU-evicted by the four later inserts (pack2 + three fillers), so deleting
 *  it makes its non-tip content (never-advertised ancestor A, trees, blobs)
 *  read through to R2 and fail. Every push is a CREATE (old = ZERO_OID). */
async function evictRepo(slug: string): Promise<EvictRepo> {
  const { storageKey, token, repoId } = await createRepo(slug);
  // Keep the default-branch settle legs (the license sync rides the engine's
  // onPush seam, services/webhooks-push.ts) off this fixture's deletion
  // target: the leg reads the DEFAULT branch's tip tree after every push, and
  // a main-push scan would inflate tree2 into the DO's GitStore-lifetime
  // object cache — masking the injected tree-missing forever after (the
  // chunk-LRU eviction below never touches the object cache). Point D1's
  // default branch at the root push instead (packR — never a deletion
  // target, and license-file-free so the leg reads no blobs).
  await drizzle(env.DB).update(repositories).set({ defaultBranch: "root" }).where(eq(repositories.id, repoId));
  const target = { engineName: `alice/${slug}`, storageKey };
  const stub = env.REPO.getByName(target.engineName);
  let before = new Set<string>();

  const root = await commitPack("root", [], [{ name: "root.txt", content: "root" }], T0);
  await pushSlug(slug, token, [{ ref: "refs/heads/root", oid: root.oid }], root.pack);
  const packRoot = await addedPackKey(before, storageKey);
  before = await packKeySet(storageKey);

  // pack1 carries TWO commits: A (never a ref tip — stays cache-cold) and
  // B, both reusing treeR so B's tree check reads the SURVIVING packR.
  const a = await commitObject(root.treeOid, [root.oid], "a", T0 + 1);
  const b = await commitObject(root.treeOid, [a.oid], "b", T0 + 2);
  await pushSlug(slug, token, [{ ref: "refs/heads/base", oid: b.oid }], await packOf([a, b]));
  const pack1 = await addedPackKey(before, storageKey);
  before = await packKeySet(storageKey);

  const c1 = await commitPack("c1", [b.oid], [{ name: "c1.txt", content: "c1" }], T0 + 3);
  await pushSlug(slug, token, [{ ref: "refs/heads/main", oid: c1.oid }], c1.pack);
  const pack2 = await addedPackKey(before, storageKey);

  // Three filler pushes: with pack2's upload that is the four later chunk
  // inserts which push pack1 out of the DO's 4-slot chunk LRU (packR goes
  // with it), so deleted-pack reads cannot be served from memory. pack2's
  // chunk stays hot here — packR-side reads of the closure walk hit it, and
  // the cold-pack2 case is treeRepo's (below) with its own four inserts.
  let parent: { oid: string } = c1;
  for (let n = 1; n <= 3; n += 1) {
    const f = await commitPack(`f${n}`, [parent.oid], [{ name: `f${n}.txt`, content: String(n) }], T0 + 3 + n);
    await pushSlug(slug, token, [{ ref: `refs/heads/filler${n}`, oid: f.oid }], f.pack);
    parent = f;
  }

  // base must not remain a ref tip (its pack is the deletion target), and
  // HEAD (adopted to root, the first branch) must point at the survivor.
  expect((await stub.deleteApiRef({ ref: "refs/heads/base", expectedOid: b.oid })).tag).toBe("deleted");
  expect((await stub.setHead("main")).tag).toBe("ok");

  return {
    storageKey,
    token,
    target,
    oids: { root: root.oid, a: a.oid, b: b.oid, c1: c1.oid },
    treeC1: c1.treeOid,
    packs: { packRoot, pack1, pack2 },
  };
}

/** The tree test's six-push fixture (module docstring): the same chain as
 *  evictRepo but with the root and base closures riding ONE pack (two
 *  create-updates in a single receive round-trip), so the deletion target
 *  pack2 lands at push 2 and the four filler uploads evict its chunk. The
 *  deletion-target geometry is identical to the old seven-push shape: C1 is
 *  a cached tip whose tree2/blob2 are cache-cold, every surviving ancestor
 *  (B/A/root, treeR, blobR) lives in the SURVIVING packRB, and the reachable
 *  walks of the filler tips still read through the dead pack (their
 *  closure-broken reports). The defaultBranch pin and the base/HEAD hygiene
 *  are evictRepo's, for the same reasons (see there; the deleteApiRef seam
 *  verdict is threePackRepo's comment). */
async function treeRepo(slug: string): Promise<EvictRepo> {
  const { storageKey, token, repoId } = await createRepo(slug);
  await drizzle(env.DB).update(repositories).set({ defaultBranch: "root" }).where(eq(repositories.id, repoId));
  const target = { engineName: `alice/${slug}`, storageKey };
  const stub = env.REPO.getByName(target.engineName);
  let before = new Set<string>();

  // packRB: root's self-contained closure PLUS the never-advertised pair
  // (A→root, B→A, both reusing treeR) — five objects, one pack, two refs.
  const blobR = await blobObject("root");
  const treeR = await treeObject([{ name: "root.txt", oid: blobR.oid }]);
  const root = await commitObject(treeR.oid, [], "root", T0);
  const a = await commitObject(treeR.oid, [root.oid], "a", T0 + 1);
  const b = await commitObject(treeR.oid, [a.oid], "b", T0 + 2);
  await pushSlug(
    slug,
    token,
    [
      { ref: "refs/heads/root", oid: root.oid },
      { ref: "refs/heads/base", oid: b.oid },
    ],
    await packOf([blobR, treeR, root, a, b]),
  );
  const packRB = await addedPackKey(before, storageKey);
  before = await packKeySet(storageKey);

  const c1 = await commitPack("c1", [b.oid], [{ name: "c1.txt", content: "c1" }], T0 + 3);
  await pushSlug(slug, token, [{ ref: "refs/heads/main", oid: c1.oid }], c1.pack);
  const pack2 = await addedPackKey(before, storageKey);

  // The four filler uploads are exactly the four later chunk inserts that
  // push pack2 out of the DO's 4-slot chunk LRU (packRB goes with them).
  let parent: { oid: string } = c1;
  for (let n = 1; n <= 4; n += 1) {
    const f = await commitPack(`f${n}`, [parent.oid], [{ name: `f${n}.txt`, content: String(n) }], T0 + 3 + n);
    await pushSlug(slug, token, [{ ref: `refs/heads/filler${n}`, oid: f.oid }], f.pack);
    parent = f;
  }

  // Same survivor hygiene as evictRepo: base's tip must not be advertised
  // and HEAD must point at main (the surviving chain over the dead pack).
  expect((await stub.deleteApiRef({ ref: "refs/heads/base", expectedOid: b.oid })).tag).toBe("deleted");
  expect((await stub.setHead("main")).tag).toBe("ok");

  return {
    storageKey,
    token,
    target,
    oids: { root: root.oid, a: a.oid, b: b.oid, c1: c1.oid },
    treeC1: c1.treeOid,
    packs: { packRoot: packRB, pack1: packRB, pack2 },
  };
}

// ---------------------------------------------------------------------------
// 1. Healthy repos pass
// ---------------------------------------------------------------------------

describe("checkRepoInvariants: healthy repos", () => {
  it("a fully seeded repo passes with a complete closure walk", async () => {
    const seeded = await threePackRepo("inv-healthy");
    const report = await checkRepoInvariants(env, seeded.target);
    expect(report.ok).toBe(true);
    expect(report.partial).toBe(false);
    expect(report.violations).toEqual([]);
    // one HEAD per cataloged pack — every push landed exactly one pack.
    expect(report.checked).toEqual({ refs: 1, commits: 3, trees: 2, blobs: 2, packs: 3 });
  });

  it("a multi-pack repo passes (walk crosses pack boundaries)", async () => {
    const seeded = await evictRepo("inv-evict-healthy");
    const report = await checkRepoInvariants(env, seeded.target);
    expect(report.ok).toBe(true);
    expect(report.partial).toBe(false);
    expect(report.violations).toEqual([]);
    // tips: main + root + 3 fillers; chain c1→B→A→root; trees: tree2,
    // treeR (B and A and root dedup), 3 filler trees; one blob spot per tree.
    expect(report.checked.refs).toBe(5);
    expect(report.checked.commits).toBe(7);
    expect(report.checked.trees).toBe(5);
  });

  it("an empty (never-pushed) repo passes trivially", async () => {
    const { storageKey } = await createRepo("inv-empty");
    const report = await checkRepoInvariants(env, { engineName: "alice/inv-empty", storageKey });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.checked.refs).toBe(0);
  });

  it("budgets bound the walk and mark the report partial (never violated)", async () => {
    // A four-commit chain on four refs, every push a create: refs=4 tips,
    // 4 distinct trees.
    const { storageKey, token } = await createRepo("inv-budget");
    const target = { engineName: "alice/inv-budget", storageKey };
    const c0 = await commitPack("c0", [], [{ name: "f0.txt", content: "0" }], T0);
    await pushSlug("inv-budget", token, [{ ref: "refs/heads/r0", oid: c0.oid }], c0.pack);
    let parent = c0;
    for (const n of [1, 2, 3]) {
      const commit = await commitPack(`c${n}`, [parent.oid], [{ name: `f${n}.txt`, content: String(n) }], T0 + n);
      await pushSlug("inv-budget", token, [{ ref: `refs/heads/r${n}`, oid: commit.oid }], commit.pack);
      parent = commit;
    }

    const byCommits = await checkRepoInvariants(env, target, { maxCommits: 2 });
    expect(byCommits.ok).toBe(true);
    expect(byCommits.partial).toBe(true);
    expect(byCommits.checked.commits).toBe(2);

    const byRefs = await checkRepoInvariants(env, target, { maxRefs: 1 });
    expect(byRefs.ok).toBe(true);
    expect(byRefs.partial).toBe(true);
    expect(byRefs.checked.refs).toBe(1);

    const byTrees = await checkRepoInvariants(env, target, { maxTrees: 2 });
    expect(byTrees.ok).toBe(true);
    expect(byTrees.partial).toBe(true);
    expect(byTrees.checked.trees).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Injected violations fail with the right kinds (R2 pack deletions)
// ---------------------------------------------------------------------------

describe("checkRepoInvariants: injected violations", () => {
  it("deleting a never-advertised ancestor's pack ⇒ closure-broken at that commit", async () => {
    const seeded = await evictRepo("inv-closure");
    await env.REPO_PACKS.delete(seeded.packs.pack1);
    const report = await checkRepoInvariants(env, seeded.target);
    expect(report.ok).toBe(false);
    expect(report.partial).toBe(false);
    // A mid-chain pack loss poisons every tip's provable closure (the DO's
    // reachability walk reads through the dead node), so every visited tip
    // reports — but every READ-path violation is a closure-broken, and the
    // never-advertised ancestor A (the actually-deleted content) is among
    // them. The catalog cross-check adds the one catalog-pack-missing for
    // the deleted pack itself (cache-independent — see the docstring).
    expect(report.violations.length).toBeGreaterThanOrEqual(1);
    expect(
      report.violations.every((v) => v.kind === "closure-broken" || v.kind === "catalog-pack-missing"),
    ).toBe(true);
    expect(report.violations.some((v) => v.oid === seeded.oids.a)).toBe(true);
    const missing = report.violations.find((v) => v.kind === "catalog-pack-missing");
    expect(missing?.detail).toContain("pack");
  });

  it("deleting a tree's pack ⇒ tree-missing under the readable tip", async () => {
    const seeded = await treeRepo("inv-tree");
    await env.REPO_PACKS.delete(seeded.packs.pack2);
    const report = await checkRepoInvariants(env, seeded.target);
    expect(report.ok).toBe(false);
    // The tip commit itself reads from the DO's object cache (mask, see the
    // module docstring); its tree and blob do not. Tips above the dead pack
    // also lose their provable closure (see the closure test above), and the
    // catalog half flags the deleted pack directly.
    const kinds = new Set(report.violations.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(["catalog-pack-missing", "closure-broken", "tree-missing"]);
    const tree = report.violations.find((v) => v.kind === "tree-missing");
    expect(tree?.oid).toBe(seeded.treeC1);
  });

  it("a dangling HEAD over advertised refs ⇒ head-missing", async () => {
    const { storageKey, token } = await createRepo("inv-head");
    const a = await commitPack("a", [], [{ name: "a.txt", content: "one" }], T0);
    await pushSlug("inv-head", token, [{ ref: "refs/heads/main", oid: a.oid }], a.pack);
    const d = await commitPack("d", [a.oid], [{ name: "d.txt", content: "dev" }], T0 + 1);
    await pushSlug("inv-head", token, [{ ref: "refs/heads/dev", oid: d.oid }], d.pack);

    const stub = env.REPO.getByName("alice/inv-head");
    expect((await stub.setHead("dev")).tag).toBe("ok");
    expect((await stub.deleteApiRef({ ref: "refs/heads/dev", expectedOid: d.oid })).tag).toBe("deleted");

    const report = await checkRepoInvariants(env, { engineName: "alice/inv-head", storageKey });
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.kind).toBe("head-missing");
  });

  it("staging orphans are flagged past the age floor, fresh staging is not", async () => {
    const seeded = await threePackRepo("inv-staging");
    const key = `repos/${seeded.storageKey}/staging/pack-rx-orphan.pack`;
    await env.REPO_PACKS.put(key, new Uint8Array([1, 2, 3]));

    // Age floor 0: the orphan is flagged with its key.
    const flagged = await checkRepoInvariants(env, seeded.target, { stagingMinAgeMs: 0 });
    expect(flagged.ok).toBe(false);
    const orphan = flagged.violations.find((v) => v.kind === "staging-orphan");
    expect(orphan?.detail).toContain("pack-rx-orphan.pack");

    // Default floor (15 min): a fresh object is presumed in-flight.
    const fresh = await checkRepoInvariants(env, seeded.target);
    expect(fresh.ok).toBe(true);

    await env.REPO_PACKS.delete(key);
  });
});

// ---------------------------------------------------------------------------
// 3. Classification the warm cache masks on a real cell: stubbed RPCs
// ---------------------------------------------------------------------------

/** Minimal checker env over hand-rolled RPC outcomes — the checker takes
 *  a structural env slice, so no casts are involved. Tips resolve by ref
 *  name (and later by their returned oid, for the parent walk); a tree
 *  with no blob entries keeps the blob spot check out of the picture.
 *  `catalogRows` feeds the listPackCatalog stub; R2 stays the REAL bucket
 *  (absent objects read as missing, so catalog fixtures need no R2 setup).
 *  `target.storageKey` picks a private packs/ prefix per test. */
function stubEnv(
  tips: Record<string, () => Promise<CommitJson | null>>,
  catalogRows: PackCatalogEntry[] = [],
): InvariantsEnv {
  const byOid = new Map<string, () => Promise<CommitJson | null>>();
  const stub = {
    listRefs: () =>
      Promise.resolve({
        head: "refs/heads/one",
        refs: Object.keys(tips).map((name) => ({ name, target: `oid-${name}` })),
      }),
    readCommit: async (id?: string) => {
      const key = id ?? "refs/heads/one";
      const resolve = tips[key] ?? byOid.get(key);
      if (resolve === undefined) throw new Error(`unresolvable: ${key}`);
      const commit = await resolve();
      if (commit !== null) byOid.set(commit.oid, resolve);
      return commit;
    },
    listTree: () => Promise.resolve({ oid: "tree", entries: [] }),
    readBlob: () => Promise.resolve(null),
    listPackCatalog: () =>
      Promise.resolve({ tag: "ok" as const, rows: catalogRows, nextCursor: null }),
  };
  return { REPO: { getByName: () => stub }, REPO_PACKS: env.REPO_PACKS };
}

describe("checkRepoInvariants: tip classification (stubbed RPCs)", () => {

  it("an unreadable tip is ref-tip-missing and the walk never starts from it", async () => {
    const okTip = () =>
      Promise.resolve({
        oid: "1".repeat(40),
        tree: "2".repeat(40),
        parents: [],
        author: { name: "x", email: "x@x", time: 0, tz: "+0000" },
        committer: { name: "x", email: "x@x", time: 0, tz: "+0000" },
        subject: "ok",
        message: "ok\n",
      });
    const envSlice = stubEnv({
      "refs/heads/one": okTip,
      "refs/heads/two": () => Promise.reject(new Error("missing R2 object")),
    });
    const report = await checkRepoInvariants(envSlice, { engineName: "stub" });
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      { kind: "ref-tip-missing", ref: "refs/heads/two", oid: "oid-refs/heads/two", detail: "missing R2 object" },
    ]);
    // HEAD points at the healthy ref — no head-missing double-report.
    expect(report.checked.refs).toBe(2);
    expect(report.checked.commits).toBe(1);
  });

  it("an unresolvable tip (null peel) is ref-tip-missing without a detail", async () => {
    const envSlice = stubEnv({
      "refs/heads/one": () => Promise.resolve(null),
    });
    const report = await checkRepoInvariants(envSlice, { engineName: "stub" });
    // HEAD names ref one, which already reported — no head-missing dup.
    expect(report.violations).toEqual([{ kind: "ref-tip-missing", ref: "refs/heads/one", oid: "oid-refs/heads/one" }]);
  });
});

// ---------------------------------------------------------------------------
// 3b. pack_catalog ↔ R2 cross-check (the cache-independent half)
// ---------------------------------------------------------------------------

describe("checkRepoInvariants: catalog cross-check", () => {
  const row = (overrides: Partial<PackCatalogEntry>): PackCatalogEntry => ({
    pack_key: `pack-${"a".repeat(40)}`,
    kind: "receive",
    state: "active",
    location: "r2",
    object_count: 3,
    pack_bytes: 1024,
    created_at: T0,
    ...overrides,
  });

  it("an active row whose R2 object vanished ⇒ catalog-pack-missing (no eviction choreography needed)", async () => {
    // The cache-mask point: pack2's bytes sit under a ref tip the DO's object
    // cache still serves, so the READ-path fixture needed a seven-push
    // eviction dance — the catalog half needs none (it reads R2 directly).
    const seeded = await threePackRepo("inv-cat-missing");
    await env.REPO_PACKS.delete(seeded.packs.p2);
    const report = await checkRepoInvariants(env, seeded.target);
    expect(report.ok).toBe(false);
    expect(report.partial).toBe(false);
    const missing = report.violations.filter((v) => v.kind === "catalog-pack-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.detail).toContain(seeded.packs.p2.split("/").pop()!);
    expect(report.checked.packs).toBe(3); // every catalog row was HEADed
  });

  it("an R2 pack object no catalog row claims ⇒ catalog-orphan; .idx sidecars are not packs", async () => {
    const seeded = await threePackRepo("inv-cat-orphan");
    const orphanKey = `repos/${seeded.storageKey}/packs/pack-${"f".repeat(40)}.pack`;
    const idxKey = `repos/${seeded.storageKey}/packs/pack-${"e".repeat(40)}.idx`;
    await env.REPO_PACKS.put(orphanKey, new Uint8Array([1]));
    await env.REPO_PACKS.put(idxKey, new Uint8Array([2]));
    const report = await checkRepoInvariants(env, seeded.target);
    expect(report.ok).toBe(false);
    const orphans = report.violations.filter((v) => v.kind === "catalog-orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.detail).toContain("pack-");
    await env.REPO_PACKS.delete(orphanKey);
    await env.REPO_PACKS.delete(idxKey);
  });

  it("a row budget truncates the catalog walk and marks the report partial", async () => {
    const seeded = await threePackRepo("inv-cat-budget");
    const report = await checkRepoInvariants(env, seeded.target, { maxCatalogRows: 2 });
    expect(report.ok).toBe(true); // the two rows seen were healthy
    expect(report.partial).toBe(true);
    expect(report.checked.packs).toBe(2);
  });

  it("stubbed catalog: active-with-missing-object flags, superseded does not", async () => {
    const okTip = () =>
      Promise.resolve({
        oid: "1".repeat(40),
        tree: "2".repeat(40),
        parents: [],
        author: { name: "x", email: "x@x", time: 0, tz: "+0000" },
        committer: { name: "x", email: "x@x", time: 0, tz: "+0000" },
        subject: "ok",
        message: "ok\n",
      });
    const goneActive = row({ pack_key: `pack-${"a".repeat(40)}` });
    const goneSuperseded = row({
      pack_key: `pack-${"b".repeat(40)}`,
      state: "superseded",
    });
    const sqliteBacked = row({
      pack_key: `pack-${"c".repeat(40)}`,
      location: "sqlite",
    });

    // Active + r2 + no object ⇒ flagged; the superseded and sqlite rows
    // beside it are deliberately unverified (M3 deletion lifecycle / DO
    // SQLite bytes no R2 probe can see).
    const flagged = await checkRepoInvariants(
      stubEnv({ "refs/heads/one": okTip }, [goneActive, goneSuperseded, sqliteBacked]),
      { engineName: "stub", storageKey: "stub-catalog-mixed" },
    );
    expect(flagged.ok).toBe(false);
    expect(flagged.violations).toHaveLength(1);
    expect(flagged.violations[0]?.kind).toBe("catalog-pack-missing");
    expect(flagged.violations[0]?.detail).toContain(goneActive.pack_key);
    expect(flagged.checked.packs).toBe(1); // only the active r2 row is HEADed

    // The same vanished object under a superseded row is NOT a violation:
    // compaction states are scheduled for deletion, their objects may
    // legitimately be gone already.
    const clean = await checkRepoInvariants(
      stubEnv({ "refs/heads/one": okTip }, [goneSuperseded]),
      { engineName: "stub", storageKey: "stub-catalog-superseded" },
    );
    expect(clean.ok).toBe(true);
    expect(clean.violations).toEqual([]);
    expect(clean.checked.packs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. run-all: enumeration, fan-out, handler
// ---------------------------------------------------------------------------

describe("run-all", () => {
  it("enumerates ready repos by keyset, skipping unsettled statuses", async () => {
    const a = await createRepo("inv-enum-a");
    const b = await createRepo("inv-enum-b");
    await drizzle(env.DB)
      .update(repositories)
      .set({ status: "creating" })
      .where(eq(repositories.id, b.repoId));

    const rows = await enumerateRepos(env);
    expect(rows).toEqual([{ engineName: "alice/inv-enum-a", storageKey: a.storageKey }]);

    // The hard cap bounds one sweep's fan-out.
    await drizzle(env.DB)
      .update(repositories)
      .set({ status: "ready" })
      .where(eq(repositories.id, b.repoId));
    expect(await enumerateRepos(env, { limit: 1 })).toHaveLength(1);
    expect((await enumerateRepos(env)).length).toBe(2);
  });

  it("fan-out messages are one-per-repo and disjoint from the other REPO_TASKS families", async () => {
    const rows = [
      { engineName: "alice/x", storageKey: "r_1" },
      { engineName: "alice/y", storageKey: "r_2" },
    ];
    const sent: unknown[] = [];
    const count = await enqueueInvariantChecks(
      { send: (m: unknown) => { sent.push(m); return Promise.resolve(); } },
      rows,
    );
    expect(count).toBe(2);
    expect(sent).toEqual([
      { kind: "invariant-check", engineName: "alice/x", storageKey: "r_1" },
      { kind: "invariant-check", engineName: "alice/y", storageKey: "r_2" },
    ]);
    for (const message of sent) expect(isInvariantCheckMessage(message)).toBe(true);

    // No collision with the shared queue's other families.
    expect(isInvariantCheckMessage({ storageKey: "r_1", engineNames: [] })).toBe(false); // repo purge
    expect(isInvariantCheckMessage({ kind: "import-chunk", importId: 1, repoId: "r" })).toBe(false); // import
    expect(isInvariantCheckMessage(null)).toBe(false);
  });

  it("handler runs the checker: healthy acks green, violations report red", async () => {
    const healthy = await threePackRepo("inv-handler-ok");
    const green: InvariantReport = await handleInvariantCheckMessage(env, {
      kind: "invariant-check",
      engineName: healthy.target.engineName,
      storageKey: healthy.storageKey,
    });
    expect(green.ok).toBe(true);

    // Content violation via an injected staging orphan (R2-observable
    // regardless of the DO's object caches); the zero age floor stands in
    // for the sweep's lease-expiry reality.
    await env.REPO_PACKS.put(`repos/${healthy.storageKey}/staging/pack-rx-lost.pack`, new Uint8Array([9]));
    const red = await handleInvariantCheckMessage(
      env,
      {
        kind: "invariant-check",
        engineName: healthy.target.engineName,
        storageKey: healthy.storageKey,
      },
      { stagingMinAgeMs: 0 },
    );
    expect(red.ok).toBe(false);
    expect(red.violations[0]?.kind).toBe("staging-orphan");
  });
});
