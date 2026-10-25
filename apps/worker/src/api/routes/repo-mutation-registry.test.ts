/**
 * The flagged tail of the REDEPLOY8 registry fix (4f574e9) — the same bug
 * class at the MUTATION sites. The create wave constructed RepoService bare
 * on the API create paths; this wave constructs it bare on the API mutation
 * paths, where the optional engine deps gate the engine half of each
 * mutation:
 *
 *   - PATCH /repos/{owner}/{repo} (repoEdit, api/routes/repo.ts): the bare
 *     service skips rename's `syncRegistryMove`, setVisibility's
 *     `setConfig(priv)`, and setDefaultBranch's `setHead` — the D1 row moves
 *     but the engine keeps serving (and indexing) the OLD name, the OLD
 *     visibility, and the OLD head.
 *   - POST /repos/{owner}/{repo}/transfer/accept (api/routes/repo-extras-t2.ts):
 *     the bare service skips `syncRegistryMove` — the transferred repo is
 *     invisible at its NEW url ("repository not found" on info/refs) while
 *     the registry still advertises the stale old key.
 *
 * Each case drives the PRODUCTION route (SELF, real token auth) and asserts
 * the engine state through the same two seams as api-create-registry.test.ts:
 * the Registry DO row (direct) and the anonymous info/refs advertisement
 * (the reported repro surface). The DO-head assertions for the default-branch
 * case read the RepoCell directly (`listRefs().head`), the same seam
 * repos/lifecycle.test.ts uses for its service-level setDefaultBranch tests.
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { buildPack, buildReceivePackBody } from "../../repos/testing/git-pack";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

/** Reset lifecycle state; the migration-seeded 'assets' reservation user
 *  stays (production shape: the reserved row is never deletable via API). */
beforeEach(async () => {
  for (const table of [
    "repo_settings",
    "webhook_deliveries",
    "webhooks",
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

/** Anonymous upload-pack advertisement fetch — the reported repro surface. */
async function uploadAdvert(owner: string, name: string): Promise<Response> {
  return SELF.fetch(`https://example.com/${owner}/${name}.git/info/refs?service=git-upload-pack`);
}

/** The direct seam assertion: the Registry DO has the repo's engine key. */
async function registryHas(engineName: string): Promise<boolean> {
  return (await env.REGISTRY.getByName("registry").get(engineName)) !== null;
}

/** The Registry DO row (null when absent) — `priv` carries the visibility. */
async function registryRow(engineName: string) {
  return env.REGISTRY.getByName("registry").get(engineName);
}

/** The RepoCell's head ref — the engine half of a default-branch change. */
async function cellHead(engineName: string): Promise<string | null> {
  return (await env.REPO.getByName(engineName).listRefs()).head;
}

/** POST /api/v1/user/repos through the real worker. */
async function apiCreateRepo(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch("https://example.com/api/v1/user/repos", {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Authenticated JSON call against an /api/v1 repo route. */
async function apiJson(
  method: "PATCH" | "POST",
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1${path}`, {
    method,
    headers: { authorization: basicTokenHeader(token), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

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

describe("REDEPLOY8 tail — repo mutations reach the engine Registry/RepoCell", () => {
  it("PATCH rename: the registry row moves to the new key and the new url serves immediately", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const created = await apiCreateRepo(token, { name: "mover", private: false });
    expect(created.status).toBe(201);
    expect(await registryHas("alice/mover")).toBe(true);

    const patched = await apiJson("PATCH", "/repos/alice/mover", token, { name: "moved" });
    expect(patched.status).toBe(200);

    // The seam: syncRegistryMove upserted the NEW key BEFORE removing the old.
    expect(await registryHas("alice/moved")).toBe(true);
    expect(await registryHas("alice/mover")).toBe(false);

    // The repro: minutes of 404 "repository not found" at the new url pre-fix.
    const advert = await uploadAdvert("alice", "moved");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("PATCH visibility flip: the registry row's priv config follows the D1 visibility", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const created = await apiCreateRepo(token, { name: "visflip", private: false });
    expect(created.status).toBe(201);
    expect((await registryRow("alice/visflip"))!.priv).toBe(0);

    const toPrivate = await apiJson("PATCH", "/repos/alice/visflip", token, { private: true });
    expect(toPrivate.status).toBe(200);
    expect((await registryRow("alice/visflip"))!.priv).toBe(1);

    // And back (setConfig carries the boolean either direction).
    const toPublic = await apiJson("PATCH", "/repos/alice/visflip", token, { private: false });
    expect(toPublic.status).toBe(200);
    expect((await registryRow("alice/visflip"))!.priv).toBe(0);
  });

  it("PATCH default branch: the RepoCell head moves (setHead), not just the D1 column", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const created = await apiCreateRepo(token, { name: "headset", private: false });
    expect(created.status).toBe(201);

    // Real branches in the DO: the first push adopts HEAD onto main (the
    // engine's dangling-HEAD rule); the second branch leaves HEAD alone —
    // so PATCHing the default to `feature` is observable ONLY through the
    // service's setHead dep. (buildPack is deterministic: both refs share
    // the commit, which is legal git.)
    const { oid, pack } = await buildPack();
    expect((await pushRef(token, "alice", "headset", "refs/heads/main", oid, pack)).status).toBe(200);
    expect((await pushRef(token, "alice", "headset", "refs/heads/feature", oid, pack)).status).toBe(200);
    expect(await cellHead("alice/headset")).toBe("refs/heads/main");

    const patched = await apiJson("PATCH", "/repos/alice/headset", token, {
      default_branch: "feature",
    });
    expect(patched.status).toBe(200);
    expect((await patched.json<{ default_branch: string }>()).default_branch).toBe("feature");

    // The engine half: meta.head moved in the DO (the advertisement's symref
    // and the synthetic HEAD file follow), not just D1's default_branch.
    expect(await cellHead("alice/headset")).toBe("refs/heads/feature");
  });

  it("POST transfer/accept: the registry row syncs to the new owner's key and the new url serves", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const aliceToken = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const bobToken = (await mintFor(bob.id, "w", "write:repository")).plaintext;
    const created = await apiCreateRepo(aliceToken, { name: "gift", private: false });
    expect(created.status).toBe(201);
    expect(await registryHas("alice/gift")).toBe(true);

    // File as the owner, accept as the recipient (the landed grant: repo
    // owner, target owner, or site admin) at the repo's CURRENT path —
    // resolution has no pending-transfer arm.
    const filed = await apiJson("POST", "/repos/alice/gift/transfer", aliceToken, {
      new_owner: "bob",
    });
    expect(filed.status).toBe(202);
    const accepted = await apiJson("POST", "/repos/alice/gift/transfer/accept", bobToken);
    expect(accepted.status).toBe(202);

    // The seam: the registry advertises the NEW location, not the stale one.
    expect(await registryHas("bob/gift")).toBe(true);
    expect(await registryHas("alice/gift")).toBe(false);

    // The repro: the transferred repo invisible at its new url pre-fix.
    const advert = await uploadAdvert("bob", "gift");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("control (the pre-fix shape): a bare-construction rename leaves the registry at the old key", async () => {
    // The bug mechanism, pinned: the service's engine deps are OPTIONAL (the
    // D1 halves run standalone), so a bare `new RepoService(db)` mutation
    // updates D1 while the engine keeps its old state. This is the
    // load-bearing difference the production paths above no longer have.
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const created = await apiCreateRepo(token, { name: "baremover", private: false });
    expect(created.status).toBe(201);

    const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, "baremover")).get())!;
    await new RepoService(env.DB).rename(row.id, "baremoved");

    const fresh = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, row.id)).get())!;
    expect(fresh.slug).toBe("baremoved"); // D1 moved…
    expect(await registryHas("alice/baremover")).toBe(true); // …the engine did not
    expect(await registryHas("alice/baremoved")).toBe(false);
  });
});
