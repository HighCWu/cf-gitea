/**
 * Repo lifecycle — SPEC-0003 §2.5 (M2): rename/redirects, transfer,
 * visibility (repo + owner), ACL rows 4/5/10/13, delete ordering (§2.5.5,
 * §4.2 push-during-delete), §4.8 recreate-with-fresh-storage_key, the
 * SPEC-0008 `assets` reservation and the §2.5.1 counter seeding.
 *
 * Real D1 + real engine DOs/R2 (SELF.fetch + direct service calls).
 */

import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import {
  RepoNameCollisionError,
  RepoNameInvalidError,
  RepoService,
  isReservedOwnerName,
  isUsableRepoName,
  lookupRedirect,
} from "./service";
import { purgeRepoMessage, tombstoneRepoDO } from "./purge";
import { settleCreatingRepo } from "../git-http/gate";
import { repoCounters, repoRedirects, repositories, repoTransfer, repoUnits, users } from "../db/schema";
import { ZERO_OID, buildPack, buildReceivePackBody } from "./testing/git-pack";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["personal_access_tokens", "repo_units", "repo_transfer", "repo_redirects", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

// Service with the real engine bindings (registry + tombstone via the repo
// DO's admin DELETE); the queue producer is not wired in vitest, so delete
// tests drive purgeRepoMessage directly.
function service(): RepoService {
  return new RepoService(env.DB, {
    registry: env.REGISTRY.getByName("registry"),
    tombstone: (name) => tombstoneRepoDO(env, name),
  });
}

async function createRepo(
  owner: { id: number; usernameLower: string },
  name: string,
  isPrivate = false,
): Promise<ReturnType<RepoService["create"]>> {
  return service().create({ owner, name, isPrivate });
}

describe("rename + redirects (SPEC-0003 §2.5.3, ACL row 13)", () => {
  it("301s the old URL to the canonical path BEFORE auth, then serves the repo at the new one", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await createRepo({ id: alice.id, usernameLower: "alice" }, "renamed-later");

    // Pre-rename: the advert serves (public repo, registry synced).
    const before = await SELF.fetch(
      "https://example.com/alice/renamed-later.git/info/refs?service=git-upload-pack",
    );
    expect(before.status).toBe(200);

    await service().rename((await service().getBySlug("alice", "renamed-later"))!.id, "renamed-now");

    // Row 13: the old URL 301s — no auth challenge, .git suffix, tail and
    // query preserved (git clients must see the redirect before a prompt).
    // (redirect: "manual" — SELF.fetch follows by default.)
    const old = await SELF.fetch(
      "https://example.com/alice/renamed-later.git/info/refs?service=git-receive-pack",
      { redirect: "manual" },
    );
    expect(old.status).toBe(301);
    expect(old.headers.get("www-authenticate")).toBeNull();
    expect(old.headers.get("location")).toBe(
      "https://example.com/alice/renamed-now.git/info/refs?service=git-receive-pack",
    );

    // The e2e-ish shape: the old READ probe 301s and the followed URL serves
    // the real advert. (The old WRITE probe's followed URL 401s — an anonymous
    // push advert on an existing repo challenges, exactly like upstream.)
    const oldRead = await SELF.fetch(
      "https://example.com/alice/renamed-later.git/info/refs?service=git-upload-pack",
      { redirect: "manual" },
    );
    expect(oldRead.status).toBe(301);
    expect(oldRead.headers.get("location")).toBe(
      "https://example.com/alice/renamed-now.git/info/refs?service=git-upload-pack",
    );
    const followed = await SELF.fetch(oldRead.headers.get("location")!);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const writeFollow = await SELF.fetch(old.headers.get("location")!);
    expect(writeFollow.status).toBe(401);
    expect(writeFollow.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');

    // Plain HEAD-file probes redirect too, preserving the sub-route.
    const head = await SELF.fetch("https://example.com/alice/renamed-later.git/HEAD", {
      redirect: "manual",
    });
    expect(head.status).toBe(301);
    expect(head.headers.get("location")).toBe("https://example.com/alice/renamed-now.git/HEAD");
  });

  it("validates names with the upstream rules (port of IsUsableRepoName)", async () => {
    expect(isUsableRepoName("ok.name-1")).toBe(true);
    expect(isUsableRepoName("has..dots")).toBe(false);
    expect(isUsableRepoName("ends.wiki")).toBe(false);
    expect(isUsableRepoName("ends.GIT")).toBe(false); // keeps the §4.4 trim unambiguous
    expect(isUsableRepoName("ends.rss")).toBe(false);
    expect(isUsableRepoName("ends.atom")).toBe(false);
    // Upstream's `^[-.\w]+$` allows a leading dash, but the engine's URL
    // alphabet (REPO_NAME) requires an alphanumeric first char — such repos
    // would be unreachable over git HTTP, so the port rejects them too.
    expect(isUsableRepoName("-leading-dash")).toBe(false);
    expect(isUsableRepoName("has space")).toBe(false);

    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "valid");
    await expect(service().rename(repo.id, "bad..name")).rejects.toBeInstanceOf(RepoNameInvalidError);
    await expect(service().rename(repo.id, "bad.git")).rejects.toBeInstanceOf(RepoNameInvalidError);
  });

  it("arbitrates collisions on UNIQUE(owner, name) and consumes redirect shadows (§4.11)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const first = await createRepo({ id: alice.id, usernameLower: "alice" }, "one");
    const second = await createRepo({ id: alice.id, usernameLower: "alice" }, "two");

    // Rename onto an EXISTING repo → the UNIQUE constraint aborts (409).
    await service().rename(first.id, "moved-away");
    await expect(service().rename(second.id, "moved-away")).rejects.toBeInstanceOf(RepoNameCollisionError);
    expect((await service().getBySlug("alice", "two"))?.id).toBe(second.id);

    // Shadow rule: renaming onto a name that has a live redirect deletes it
    // first and SUCCEEDS (upstream NewRedirect, models/repo/redirect.go:81-92
    // — redirect rows are not part of the repo namespace).
    expect(await lookupRedirect(env.DB, "alice", "one")).not.toBeNull(); // one → first
    await service().rename(second.id, "one");
    expect(await lookupRedirect(env.DB, "alice", "one")).toBeNull(); // consumed
    expect((await lookupRedirect(env.DB, "alice", "two"))?.slug).toBe("one"); // second's old name
  });

  it("keeps storage_key and refs_version immutable across renames", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "stable-key");
    await service().rename(repo.id, "stable-key-renamed");
    const after = (await service().getBySlug("alice", "stable-key-renamed"))!;
    expect(after.storageKey).toBe(repo.storageKey);
    expect(after.refsVersion).toBe(0);
  });
});

describe("transfer (SPEC-0003 §2.5.4)", () => {
  it("moves ownership, registers the redirect under the OLD owner, and drops anonymous access with the new owner's visibility", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const svc = service();
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "moving");

    await svc.requestTransfer(repo.id, alice.id, bob.id);
    expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(1);

    await svc.acceptTransfer(repo.id, { id: alice.id, isAdmin: false });

    const moved = (await svc.get(repo.id))!;
    expect(moved.ownerNamespace).toBe("bob");
    expect(moved.ownerId).toBe(bob.id);
    // storage untouched; redirect lives under the OLD owner
    expect(moved.storageKey).toBe(repo.storageKey);
    expect(await lookupRedirect(env.DB, "alice", "moving")).not.toBeNull();

    // Old-owner URL 301s to the new location; the followed URL serves.
    const old = await SELF.fetch("https://example.com/alice/moving.git/info/refs?service=git-upload-pack", {
      redirect: "manual",
    });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("https://example.com/bob/moving.git/info/refs?service=git-upload-pack");
    expect((await SELF.fetch(old.headers.get("location")!)).status).toBe(200);

    // Visibility re-check is implicit (§2.5.4): transfer to a limited owner
    // immediately hides the repo from anonymous readers.
    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, bob.id));
    expect((await SELF.fetch("https://example.com/bob/moving.git/info/refs?service=git-upload-pack")).status).toBe(401);
  });

  it("rejects unauthorized accepts and missing targets; cancel removes the pending row", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const carol = await seedVerifiedUser({ username: "Carol" });
    const svc = service();
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "guarded");

    await expect(svc.requestTransfer(repo.id, alice.id, alice.id)).rejects.toThrow("already owned");
    await expect(svc.requestTransfer(repo.id, alice.id, 424242)).rejects.toThrow("does not exist");
    await svc.requestTransfer(repo.id, alice.id, bob.id);
    await expect(svc.acceptTransfer(repo.id, { id: carol.id, isAdmin: false })).rejects.toThrow(
      "only the repo owner",
    );
    await svc.cancelTransfer(repo.id);
    expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(0);
  });
});

describe("visibility model (SPEC-0003 §2.5.6) and ACL rows 4/5/10", () => {
  const refs = "https://example.com/alice/alice.git/info/refs?service=git-upload-pack";
  const pushRefs = "https://example.com/alice/alice.git/info/refs?service=git-receive-pack";

  it("flips repo visibility and the matrix follows (no invalidation needed)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const svc = service();
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "alice", false);

    expect((await SELF.fetch(refs)).status).toBe(200); // row 1
    await svc.setVisibility(repo.id, true);
    expect((await SELF.fetch(refs)).status).toBe(401); // row 2
    await svc.setVisibility(repo.id, false);
    expect((await SELF.fetch(refs)).status).toBe(200); // row 1 again
  });

  it("owner visibility gates anonymous access: limited = authenticated-only, private = owner/admin", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const outsider = await seedVerifiedUser({ username: "Outsider" });
    await createRepo({ id: alice.id, usernameLower: "alice" }, "alice");
    const outsiderToken = (await mintFor(outsider.id, "ro", "read:repository")).plaintext;

    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, alice.id));
    expect((await SELF.fetch(refs)).status).toBe(401); // anonymous: row 2
    expect(
      (await SELF.fetch(refs, { headers: { authorization: basicTokenHeader(outsiderToken) } })).status,
    ).toBe(200); // any authenticated principal

    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, alice.id));
    expect(
      (await SELF.fetch(refs, { headers: { authorization: basicTokenHeader(outsiderToken) } })).status,
    ).toBe(404); // invisible to non-owners
    const aliceToken = (await mintFor(alice.id, "ro", "read:repository")).plaintext;
    expect((await SELF.fetch(refs, { headers: { authorization: basicTokenHeader(aliceToken) } })).status).toBe(200);
  });

  it("rows 4/5: an anonymous unit-read grant opens fetch but never push on a private repo", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "alice", true);
    await drizzle(env.DB)
      .insert(repoUnits)
      .values({ repoId: repo.id, type: "code", anonymousAccessMode: "read" });

    expect((await SELF.fetch(refs)).status).toBe(200); // row 4
    const push = await SELF.fetch(pushRefs);
    expect(push.status).toBe(401); // row 5: unit read never grants write
    expect(push.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
  });

  it("row 10: archived repos refuse pushes with the upstream message but keep cloning", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "alice", false);
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));

    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const push = await SELF.fetch("https://example.com/alice/alice.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
    expect(push.status).toBe(403);
    expect(await push.text()).toBe(
      "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests.",
    );
    expect((await SELF.fetch(refs)).status).toBe(200); // clone still works
  });
});

describe("delete pipeline (SPEC-0003 §2.5.5, §4.2, §4.8)", () => {
  it("deletes D1 rows in one transaction, then tombstones + purges storage via the queue message", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const svc = service();
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "doomed");
    await svc.rename(repo.id, "doomed-renamed"); // leaves a redirect at doomed

    // Storage + registry rows the name-addressed engine wrote.
    await env.REPO_PACKS.put(`repos/alice/doomed-renamed/packs/pack-x.pack`, new Uint8Array([1, 2, 3]));
    await env.REPO_PACKS.put(`imports/alice/doomed-renamed/chunk-0.pack`, new Uint8Array([4]));
    await env.REGISTRY.getByName("registry").upsert("alice/doomed-renamed", Date.now());

    const { engineNames } = await svc.deleteRepository(repo.id);
    expect(engineNames.sort()).toEqual(["alice/doomed", "alice/doomed-renamed"].sort());

    // Step 1 (D1): the row and every dependent — gone in the batch.
    expect(await svc.get(repo.id)).toBeNull();
    expect(await drizzle(env.DB).select().from(repoRedirects).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(0);

    // Steps 2-3: the queue message drives tombstone + R2 prefix purge.
    await purgeRepoMessage(env, { storageKey: repo.storageKey, engineNames });
    expect((await env.REPO_PACKS.list({ prefix: "repos/alice/doomed-renamed/" })).objects).toHaveLength(0);
    expect((await env.REPO_PACKS.list({ prefix: "imports/alice/doomed-renamed/" })).objects).toHaveLength(0);
    expect(await env.REGISTRY.getByName("registry").get("alice/doomed-renamed")).toBeNull();
  });

  it("§4.2: a push holding a receive lease fails cleanly when the delete lands mid-flight", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "racy", false);

    // A push opened its lease (the DO is warmed by the tombstone's bind).
    const stub = env.REPO.getByName("alice/racy");
    const begin = await stub.beginReceive({
      commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
      capabilities: ["report-status"],
      packBytesHint: null,
    });
    expect(begin.tag).toBe("ok");

    // Delete wins the race: the tombstone wipes the DO under the lease.
    await service().deleteRepository(repo.id);

    // The in-flight finalize aborts on the wiped lease table — no dangling
    // refs, the client sees a failed push.
    if (begin.tag !== "ok") throw new Error("expected a lease");
    const fin = await stub.finalizeReceive({
      leaseToken: begin.leaseToken,
      expectedRefsVersion: begin.refsVersion,
      commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
      newTips: [null],
      pack: { packKey: "", packSha1: ZERO_OID, packBytes: 0, objectCount: 0, idxBytes: 0 },
      unpackError: null,
    });
    expect(fin.tag).toBe("lease_mismatch");
  });

  it("§4.8: recreating at the same name gets a fresh id/storage_key and old URLs hit the new repo", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const svc = service();
    const original = await createRepo({ id: alice.id, usernameLower: "alice" }, "recycled");
    await svc.rename(original.id, "recycled-elsewhere"); // leave a stale redirect
    await svc.deleteRepository(original.id);

    const fresh = await createRepo({ id: alice.id, usernameLower: "alice" }, "recycled");
    expect(fresh.id).not.toBe(original.id);
    expect(fresh.storageKey).not.toBe(original.storageKey);
    expect(fresh.storageKey).toBe(`r_${fresh.id}`);
    expect(fresh.isEmpty).toBe(true);

    // Old redirects died with the delete: /alice/recycled now resolves the
    // NEW repo (never old data), and the stale redirect URL is a plain miss.
    expect((await lookupRedirect(env.DB, "alice", "recycled-elsewhere"))).toBeNull();
    expect((await SELF.fetch("https://example.com/alice/recycled.git/info/refs?service=git-upload-pack")).status).toBe(
      200,
    );
  });

  it("§4.2 deleted rows 404 through the matrix (no D1 row → gate miss), and the engine passthrough still gates writes", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "vanishing");
    const { engineNames } = await service().deleteRepository(repo.id);
    // The queue message removes the Registry row the engine 404s against.
    await purgeRepoMessage(env, { storageKey: repo.storageKey, engineNames });

    // Anonymous reads of a D1-missing + registry-missing repo keep the
    // engine's 404 (documented transitional passthrough — the e2e population
    // shares this path, so the gate must not challenge).
    const read = await SELF.fetch("https://example.com/alice/vanishing.git/info/refs?service=git-upload-pack");
    expect(read.status).toBe(404);
    // Anonymous writes challenge (row 15) — never a silent engine recreate.
    const write = await SELF.fetch("https://example.com/alice/vanishing.git/info/refs?service=git-receive-pack");
    expect(write.status).toBe(401);
    expect(write.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
  });
});

describe("SPEC-0008 'assets' reservation and create bookkeeping", () => {
  it("reserves the owner name 'assets' at the DB level (migration seed row + UNIQUE lower_name)", async () => {
    const seeded = await drizzle(env.DB)
      .select()
      .from(users)
      .where(eq(users.usernameLower, "assets"))
      .get();
    expect(seeded?.status).toBe("prohibited"); // the migration's reservation row

    // Drizzle wraps driver errors (DrizzleQueryError): the UNIQUE violation
    // sits in the cause chain — inspect it (any casing collides).
    try {
      await drizzle(env.DB)
        .insert(users)
        .values({ username: "Assets", usernameLower: "assets", createdAt: new Date() })
        .returning()
        .all();
      throw new Error("expected the reserved-name insert to fail");
    } catch (error) {
      const text = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
      expect(text).toContain("UNIQUE constraint failed");
    }

    expect(isReservedOwnerName("assets")).toBe(true);
    expect(isReservedOwnerName("ASSETS")).toBe(true);
    expect(isReservedOwnerName("api")).toBe(true);
    expect(isReservedOwnerName("not-reserved")).toBe(false);
  });

  it("seeds the issue/PR counter row on create (ensureRepoCounters) and derives storage_key = r_<id>", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "bookkept", true);
    expect(repo.storageKey).toBe(`r_${repo.id}`);
    const counters = await drizzle(env.DB).select().from(repoCounters).all();
    expect(counters).toHaveLength(1);
    expect(counters[0]?.repoId).toBe(repo.id);
    expect(counters[0]?.issueIndex).toBe(0);
  });

  it("pushes land a first commit and the HEAD endpoint agrees with the adopted default branch", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/trunk", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/heady.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(token),
        "content-type": "application/x-git-receive-pack-request",
      },
      body,
    });
    expect(push.status).toBe(200);

    // Settle deterministically (the gate schedules this via waitUntil); the
    // adoption writes default_branch=trunk, which the unborn-HEAD fallback
    // serves (the engine's HEAD row is only set by an explicit SetDefaultBranch
    // — the ENGINE-WAVE gap in src/repos/service.ts).
    const svc = service();
    const creating = await svc.getBySlug("alice", "heady");
    if (creating) await settleCreatingRepo(env, creating.id, "alice/heady");

    // The synthetic HEAD file (§2.1 row 4) resolves through the DO.
    const head = await SELF.fetch("https://example.com/alice/heady.git/HEAD", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("ref: refs/heads/trunk\n");
  });
});
