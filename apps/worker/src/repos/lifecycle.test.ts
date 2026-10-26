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
import { carryRepoCell } from "./carry";
import { purgeRepoMessage, tombstoneRepoDO } from "./purge";
import { settleCreatingRepo } from "../git-http/gate";
import { protectedBranches, repoCounters, repoRedirects, repositories, repoTransfer, repoUnits, users } from "../db/schema";
import { emptyRuleConfig, serializeRuleConfig } from "../services/branch-protection";
import { ZERO_OID, buildPack, buildReceivePackBody } from "./testing/git-pack";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["personal_access_tokens", "protected_branches", "repo_units", "repo_transfer", "repo_redirects", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

// Service with the real engine bindings (registry + the RepoCell markDeleted
// RPC tombstone + the cell carry); the queue producer is not wired in vitest,
// so delete tests drive purgeRepoMessage directly.
function service(): RepoService {
  return new RepoService(env.DB, {
    registry: env.REGISTRY.getByName("registry"),
    tombstone: (name) => tombstoneRepoDO(env, name),
    carry: (from, to, storageKey) => carryRepoCell(env, from, to, storageKey),
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

    // Storage + registry rows the storage-key-addressed engine wrote (R2 is
    // namespaced by the immutable D1 storage_key; the DOs stay name-bound).
    await env.REPO_PACKS.put(`repos/${repo.storageKey}/packs/pack-x.pack`, new Uint8Array([1, 2, 3]));
    await env.REPO_PACKS.put(`repos/${repo.storageKey}/staging/pack-rx-x.pack`, new Uint8Array([9]));
    await env.REPO_PACKS.put(`imports/${repo.storageKey}/chunk-0.pack`, new Uint8Array([4]));
    await env.REGISTRY.getByName("registry").upsert("alice/doomed-renamed", Date.now());

    const { engineNames } = await svc.deleteRepository(repo.id);
    expect(engineNames.sort()).toEqual(["alice/doomed", "alice/doomed-renamed"].sort());

    // Step 1 (D1): the row and every dependent — gone in the batch.
    expect(await svc.get(repo.id)).toBeNull();
    expect(await drizzle(env.DB).select().from(repoRedirects).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(0);

    // Steps 2-4: the queue message drives tombstone (markDeleted RPC) → R2
    // prefix purge under the storage_key → the final destroy.
    await purgeRepoMessage(env, { storageKey: repo.storageKey, engineNames });
    expect((await env.REPO_PACKS.list({ prefix: `repos/${repo.storageKey}/` })).objects).toHaveLength(0);
    expect((await env.REPO_PACKS.list({ prefix: `imports/${repo.storageKey}/` })).objects).toHaveLength(0);
    expect(await env.REGISTRY.getByName("registry").get("alice/doomed-renamed")).toBeNull();
    // Destroy (the final step) wiped the cells: a re-created empty DO holds
    // no tombstone flag, so beginReceive answers instead of rejecting.
    const revived = await env.REPO.getByName("alice/doomed-renamed").beginReceive({
      commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
      capabilities: [],
      packBytesHint: null,
    });
    expect(revived.tag).toBe("ok");
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

    // Delete wins the race: the markDeleted tombstone flags the DO under the
    // lease (markDeleted deliberately does not wait out the lease — the D1
    // row is gone, so the push is doomed regardless).
    await service().deleteRepository(repo.id);

    // New leases are refused outright once the doomed lease is gone
    // (markDeleted deliberately does not wait out an active lease — the D1
    // row is gone, so the push is doomed regardless) and the in-flight
    // finalize aborts on the flag — no dangling refs, the client sees a
    // failed push.
    if (begin.tag !== "ok") throw new Error("expected a lease");
    await stub.releaseReceive({ leaseToken: begin.leaseToken, sweep: false });
    const rebegin = await stub.beginReceive({
      commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
      capabilities: [],
      packBytesHint: null,
    });
    expect(rebegin.tag).toBe("rejected");
    if (rebegin.tag === "rejected") {
      expect(rebegin.results).toEqual([
        { ref: "refs/heads/main", ok: false, message: "repository deleted" },
      ]);
    }
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

  it("cascades the team_repo_access rows with the repo (SPEC-0007 §3.5 — repo_id declares no FK there)", async () => {
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const orgs = await env.DB.prepare(
      "INSERT INTO users (username, username_lower, email, is_admin, status, visibility, type, num_members, created_at) VALUES ('acme', 'acme', NULL, 0, 'active', 'public', 'org', 1, ?) RETURNING id",
    )
      .bind(Math.floor(Date.now() / 1000))
      .first<{ id: number }>();
    const orgId = orgs!.id;
    await env.DB.prepare(
      "INSERT INTO org_members (org_id, user_id, is_public, role, created_at) VALUES (?, ?, 0, 'owner', ?)",
    )
      .bind(orgId, orgOwner.id, Math.floor(Date.now() / 1000))
      .run();

    const svc = service();
    const repo = await createRepo({ id: orgId, usernameLower: "acme" }, "granted", true);
    const team = await env.DB.prepare(
      "INSERT INTO teams (org_id, lower_name, name, authorize) VALUES (?, 'readers', 'readers', 'read') RETURNING id",
    )
      .bind(orgId)
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO team_repo_access (org_id, team_id, repo_id) VALUES (?, ?, ?)")
      .bind(orgId, team!.id, repo.id)
      .run();
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM team_repo_access WHERE repo_id = ?").bind(repo.id).first<{ n: number }>())
        ?.n,
    ).toBe(1);

    await svc.deleteRepository(repo.id);
    // The grant rows died in the delete batch — a same-name re-create starts
    // with NO stale team grants (schema.ts's documented cascade convention).
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM team_repo_access WHERE repo_id = ?").bind(repo.id).first<{ n: number }>())
        ?.n,
    ).toBe(0);
  });

  it("cascades the protected_branches rows with the repo (SPEC-0013 M4 — the delete.go:171 DeleteBeans arm)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const svc = service();
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "protected", true);
    await drizzle(env.DB).insert(protectedBranches).values({
      repoId: repo.id,
      ruleName: "main",
      priority: 1,
      rules: serializeRuleConfig(emptyRuleConfig()),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM protected_branches WHERE repo_id = ?").bind(repo.id).first<{ n: number }>())
        ?.n,
    ).toBe(1);

    await svc.deleteRepository(repo.id);
    // The rules died in the delete batch (upstream's delete census deletes the
    // same rows, services/repository/delete.go:171) — a same-name re-create
    // starts unprotected.
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM protected_branches WHERE repo_id = ?").bind(repo.id).first<{ n: number }>())
        ?.n,
    ).toBe(0);
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

describe("default branch (SPEC-0003 §2.5.2 — the engine setHead RPC)", () => {
  /** Service wired to the REAL RepoCell.setHead (the production injection
   *  shape: the engine's SetHeadResult tag mapped straight through). */
  function serviceWithSetHead(): RepoService {
    return new RepoService(env.DB, {
      setHead: async (name, branch) => (await env.REPO.getByName(name).setHead(branch)).tag,
    });
  }

  it("aligns the DO head with the adopted branch when a multi-branch first push diverges", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody(
      [
        { ref: "refs/heads/develop", oid },
        { ref: "refs/heads/main", oid },
      ],
      pack,
    );
    const push = await SELF.fetch("https://example.com/alice/branchy.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(token),
        "content-type": "application/x-git-receive-pack-request",
      },
      body,
    });
    expect(push.status).toBe(200);

    // The engine's first-push adoption prefers main; the settle's
    // alphabetical adoption picks develop — the setHead alignment re-points
    // the DO so the advertisement's HEAD agrees with D1.
    const svc = service();
    const creating = await svc.getBySlug("alice", "branchy");
    expect(creating).not.toBeNull();
    if (creating === null) throw new Error("unreachable");
    await settleCreatingRepo(env, creating.id, "alice/branchy");
    const settled = (await svc.get(creating.id))!;
    expect(settled.defaultBranch).toBe("develop");
    expect((await env.REPO.getByName("alice/branchy").listRefs()).head).toBe("refs/heads/develop");
  });

  it("setDefaultBranch updates D1 and the DO head; engine rejections never block the D1 truth", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const svc = serviceWithSetHead();
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "headed");
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    await SELF.fetch("https://example.com/alice/headed.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(token),
        "content-type": "application/x-git-receive-pack-request",
      },
      body: buildReceivePackBody([{ ref: "refs/heads/feature", oid }], pack),
    });

    // OK path: both stores move.
    await svc.setDefaultBranch(repo.id, "feature");
    expect((await svc.get(repo.id))!.defaultBranch).toBe("feature");
    expect((await env.REPO.getByName("alice/headed").listRefs()).head).toBe("refs/heads/feature");

    // not_found: an unborn branch is legal in D1 (the empty-repo convention);
    // the DO keeps its head and the rejection is logged, not thrown.
    await svc.setDefaultBranch(repo.id, "ghost");
    expect((await svc.get(repo.id))!.defaultBranch).toBe("ghost");
    expect((await env.REPO.getByName("alice/headed").listRefs()).head).toBe("refs/heads/feature");
  });
});

describe("engine-cell carry (P1 registry-fix: rename/transfer/delete tails)", () => {
  /** Push one ref at `oid` into an existing (ready) repo through the gate. */
  async function pushRef(
    token: string,
    owner: string,
    name: string,
    ref: string,
    oid: string,
    pack: Uint8Array,
  ): Promise<Response> {
    return SELF.fetch(`https://example.com/${owner}/${name}.git/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(token),
        "content-type": "application/x-git-receive-pack-request",
      },
      body: buildReceivePackBody([{ ref, oid }], pack),
    });
  }

  /** Anonymous upload-pack advertisement fetch — the probe's repro surface. */
  async function uploadAdvert(owner: string, name: string): Promise<Response> {
    return SELF.fetch(`https://example.com/${owner}/${name}.git/info/refs?service=git-upload-pack`);
  }

  it("rename carries the cell: the NEW url's advertisement lists the pushed refs immediately", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "carry-push");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "carry-push", "refs/heads/main", oid, pack)).status).toBe(200);

    // Pre-rename the data cell answers under the creation name.
    const before = await env.REPO.getByName("alice/carry-push").listRefs();
    expect(before.refs.map((r) => [r.name, r.target])).toEqual([["refs/heads/main", oid]]);

    await service().rename(repo.id, "carry-pushed");

    // THE P1: the new name resolves the SAME content, immediately — the fresh
    // empty cell here was the production probe's valid-yet-empty advert.
    const after = await env.REPO.getByName("alice/carry-pushed").listRefs();
    expect(after.refs.map((r) => [r.name, r.target])).toEqual([["refs/heads/main", oid]]);
    expect(after.head).toBe("refs/heads/main");
    const advert = await uploadAdvert("alice", "carry-pushed");
    expect(advert.status).toBe(200);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(oid);

    // The old name still 301s to the canonical path (row 13, unchanged).
    const old = await SELF.fetch("https://example.com/alice/carry-push.git/info/refs?service=git-upload-pack", {
      redirect: "manual",
    });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("https://example.com/alice/carry-pushed.git/info/refs?service=git-upload-pack");
  });

  it("PATCH rename carries an auto_init repo's initial commit (the production probe repro)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const created = await SELF.fetch("https://example.com/api/v1/user/repos", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "carry-auto", private: false, auto_init: true, description: "probe" }),
    });
    expect(created.status).toBe(201);

    // The auto-init commit is LOOSE (Worker-authored via putApiObjects) — the
    // exact shape the probe renamed.
    const before = await env.REPO.getByName("alice/carry-auto").listRefs();
    expect(before.refs.map((r) => r.name)).toEqual(["refs/heads/main"]);

    const patched = await SELF.fetch("https://example.com/api/v1/repos/alice/carry-auto", {
      method: "PATCH",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "carry-auto2" }),
    });
    expect(patched.status).toBe(200);

    // Refs AND objects follow: the commit log resolves on the new cell (the
    // fsck arm — finalizeForkImport refuses unresolvable tips, and the loose
    // walk reconstructs the objects the ref tips name).
    const after = await env.REPO.getByName("alice/carry-auto2").listRefs();
    expect(after.refs.map((r) => [r.name, r.target])).toEqual([["refs/heads/main", before.refs[0]!.target]]);
    const log = await env.REPO.getByName("alice/carry-auto2").listLog("main");
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]!.message).toBe("Initial commit\n");
    const readme = await env.REPO.getByName("alice/carry-auto2").readBlob("main", "README.md");
    expect(readme === null ? "" : new TextDecoder().decode(readme.data)).toContain("# carry-auto");

    const advert = await uploadAdvert("alice", "carry-auto2");
    expect(advert.status).toBe(200);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(before.refs[0]!.target);
  });

  it("delete drops every registry entry SYNCHRONOUSLY — no anonymous read-after-delete on renamed aliases", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "doomed-alias");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "doomed-alias", "refs/heads/heal", oid, pack)).status).toBe(200);
    await service().rename(repo.id, "doomed-alias2");

    // The delete's D1+tombstone+registry half only — the queue purge (which
    // also removes registry rows) is deliberately NOT driven: the production
    // probe observed anonymous ref serving in exactly this window.
    await service().deleteRepository(repo.id);

    // The renamed path's registry entry died with the D1 cascade — before any
    // queue consumer runs. Pre-fix this row persisted and the tombstoned cell
    // kept serving the pushed ref anonymously.
    expect(await env.REGISTRY.getByName("registry").get("alice/doomed-alias2")).toBeNull();
    expect(await env.REGISTRY.getByName("registry").get("alice/doomed-alias")).toBeNull();

    // Both names answer the engine's registry-miss 404 immediately.
    const newName = await uploadAdvert("alice", "doomed-alias2");
    expect(newName.status).toBe(404);
    const oldName = await uploadAdvert("alice", "doomed-alias");
    expect(oldName.status).toBe(404);
  });

  it("delete-after-rename answers not-found at t+0 even when the pre-delete advert seeded the engine's registry memo", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "tomb-ads");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "tomb-ads", "refs/heads/main", oid, pack)).status).toBe(200);
    await service().rename(repo.id, "tomb-ads2");

    // The production lifecycle's carry verification: an anonymous advert on
    // the NEW name seconds before the delete. This is the read that seeds the
    // engine's per-isolate registry memo (packages/git-engine mod.ts infoMemo,
    // 20 s positive TTL) — the delete's awaited registry.remove cannot reach
    // into it, so pre-fix the next read on this isolate sailed past the
    // engine's !info 404 into the TOMBSTONED cell and served the refs for
    // seconds (the REDEPLOY10/11 probe's ~5.4-6.4 s window, dirty at t+0 in
    // all three trials).
    const carried = await uploadAdvert("alice", "tomb-ads2");
    expect(carried.status).toBe(200);
    expect(new TextDecoder().decode(await carried.arrayBuffer())).toContain(oid);
    // The redirect-served OLD name stays the INTENTIONAL direction while the
    // row lives (row 13: 301, and the followed canonical URL serves).
    const old = await SELF.fetch("https://example.com/alice/tomb-ads.git/info/refs?service=git-upload-pack", {
      redirect: "manual",
    });
    expect(old.status).toBe(301);
    expect((await SELF.fetch(old.headers.get("location")!)).status).toBe(200);

    // The DELETE 204's exact awaited half (D1 cascade + tombstone + registry
    // remove) — no sleep, no poll: the NEXT request is t+0.
    await service().deleteRepository(repo.id);

    // t+0 on the renamed NEW name: the gate's fresh registry oracle answers
    // the engine's byte-identical 404 — the tombstoned cell is never reached.
    const after = await uploadAdvert("alice", "tomb-ads2");
    expect(after.status).toBe(404);
    expect(await after.text()).toBe("repository not found: alice/tomb-ads2\n");
    // The upload-pack POST surface gets the same t+0 answer.
    const post = await SELF.fetch("https://example.com/alice/tomb-ads2.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: "0000",
    });
    expect(post.status).toBe(404);
    expect(await post.text()).toBe("repository not found: alice/tomb-ads2\n");
    // The old name (its redirect row cascaded with the repo) is dead too.
    expect((await uploadAdvert("alice", "tomb-ads")).status).toBe(404);
    // The engine JSON API surface: same oracle, the engine's JSON 404 shape.
    const api = await SELF.fetch("https://example.com/alice/tomb-ads2/api/refs");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "repository not found: alice/tomb-ads2" });
  });

  it("delete-without-rename also answers not-found at t+0 when a pre-delete read seeded the memo", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "tomb-plain");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "tomb-plain", "refs/heads/main", oid, pack)).status).toBe(200);
    // The non-renamed production trials measured clean only because their
    // post-delete poll landed on a memo-cold isolate; the stale entry is
    // name-agnostic — seed it the same way and assert the t+0 404.
    expect((await uploadAdvert("alice", "tomb-plain")).status).toBe(200);

    await service().deleteRepository(repo.id);

    const after = await uploadAdvert("alice", "tomb-plain");
    expect(after.status).toBe(404);
    expect(await after.text()).toBe("repository not found: alice/tomb-plain\n");
  });

  it("the engine-shape DELETE resolves a renamed repo's old name (deletes the canonical repo)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "engine-del");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "engine-del", "refs/heads/main", oid, pack)).status).toBe(200);
    await service().rename(repo.id, "engine-del2");

    // The smoke harness's cleanup shape: DELETE /{owner}/{repo} (no /api/v1)
    // at the PRE-RENAME name. Pre-fix this 301'd (row 13) and redirect-blind
    // clients stranded the repo.
    const deleted = await SELF.fetch("https://example.com/alice/engine-del", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(token) },
      redirect: "manual",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.text()).toBe("deleted\n");

    // The canonical repo is gone everywhere, both names included.
    expect(await service().getBySlug("alice", "engine-del2")).toBeNull();
    expect(await service().getBySlug("alice", "engine-del")).toBeNull();
    expect((await uploadAdvert("alice", "engine-del2")).status).toBe(404);
    expect((await uploadAdvert("alice", "engine-del")).status).toBe(404);
    const apiGet = await SELF.fetch("https://example.com/api/v1/repos/alice/engine-del2");
    expect(apiGet.status).toBe(404);
  });

  it("transfer carries the cell to the new owner namespace", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "movable");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "movable", "refs/heads/main", oid, pack)).status).toBe(200);

    const svc = service();
    await svc.requestTransfer(repo.id, alice.id, bob.id);
    await svc.acceptTransfer(repo.id, { id: alice.id, isAdmin: false });

    // The same stale-fresh-cell class as rename, one namespace over.
    const after = await env.REPO.getByName("bob/movable").listRefs();
    expect(after.refs.map((r) => [r.name, r.target])).toEqual([["refs/heads/main", oid]]);
    const advert = await uploadAdvert("bob", "movable");
    expect(advert.status).toBe(200);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(oid);
  });

  it("rename-back (a -> b -> a) survives: the stale target cell is reset, not refused", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "yoyo");
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "yoyo", "refs/heads/main", oid, pack)).status).toBe(200);

    const svc = service();
    await svc.rename(repo.id, "yoyo-away");
    await svc.rename(repo.id, "yoyo"); // back onto the stale original cell

    // The carry reset the stale cell instead of beginForkImport refusing
    // ("fork target is not empty") — the original content serves again.
    const after = await env.REPO.getByName("alice/yoyo").listRefs();
    expect(after.refs.map((r) => [r.name, r.target])).toEqual([["refs/heads/main", oid]]);
    expect((await uploadAdvert("alice", "yoyo")).status).toBe(200);
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

  it("pushes land a first commit under the D1 storage_key and the HEAD endpoint agrees with the adopted default branch", async () => {
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
    // adoption writes default_branch=trunk, and the DO head already agrees
    // (the engine adopts the only pushed branch on first push).
    const svc = service();
    const creating = await svc.getBySlug("alice", "heady");
    if (creating) await settleCreatingRepo(env, creating.id, "alice/heady");

    // The receive forwarded x-storage-key (r_<id>): the pack landed under the
    // immutable storage-key prefix — never a name-addressed one.
    expect(creating).not.toBeNull();
    if (creating === null) throw new Error("unreachable");
    const keyed = await env.REPO_PACKS.list({ prefix: `repos/${creating.storageKey}/packs/` });
    expect(keyed.objects.length).toBeGreaterThan(0);
    expect((await env.REPO_PACKS.list({ prefix: "repos/alice/heady/" })).objects).toHaveLength(0);

    // The synthetic HEAD file (§2.1 row 4) resolves through the DO.
    const head = await SELF.fetch("https://example.com/alice/heady.git/HEAD", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("ref: refs/heads/trunk\n");
  });

  it("overrides a client-supplied x-storage-key with the D1 row's on D1-backed receive forwards", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const repo = await createRepo({ id: alice.id, usernameLower: "alice" }, "forgery", true);
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/forgery.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(token),
        "content-type": "application/x-git-receive-pack-request",
        // A forged header must never redirect the storage namespace: the gate
        // re-wraps the forward and sets the header from the D1 row.
        "x-storage-key": "forged-key",
      },
      body,
    });
    expect(push.status).toBe(200);
    expect((await env.REPO_PACKS.list({ prefix: "repos/forged-key/" })).objects).toHaveLength(0);
    const keyed = await env.REPO_PACKS.list({ prefix: `repos/${repo.storageKey}/packs/` });
    expect(keyed.objects.length).toBeGreaterThan(0);
  });
});
