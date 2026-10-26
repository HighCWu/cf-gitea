/**
 * The PR converter's head-repo render (services/pulls.ts headBranchInfo) over
 * the real router — upstream's hidden-head-repo rule (services/convert/
 * pull.go:187-199 single, :435-450 list; both share the gate): a cross-repo
 * (fork) head renders `head.repo` + the numeric `head.repo_id` exactly when
 * the doer's permission ON THE HEAD REPO passes
 * `HasAnyUnitAccessOrPublicAccess` (models/perm/access/repo_permission.go:77
 * — anonymous gets AccessModeRead on a public repo, :468-472, and None on a
 * private one, :442-446; an authenticated stranger gets Read via
 * models/perm/access/access.go:53-54). An unreadable head keeps
 * `repo_id: -1` with `repo` omitted (Go marshals the nil pointer as null; our
 * JSON writer drops the undefined key) while `label`/`ref`/`sha` stay set —
 * the branch name survives the hide, upstream pull.go:118-121.
 *
 * Colocated with the converter: the broader PR fixtures live in the
 * sibling-owned src/api/pulls.test.ts / src/api/routes/pulls.test.ts (the
 * wave-34 render split). Mounting convention = src/api/pulls.test.ts over the
 * full router; the stub identity STUB_USER (id 1) answers ANY token
 * (createStubAuthResolver), so the private-fork OWNER arm below uses a
 * stub-owned private fork — a stranger-authenticated doer is not reachable in
 * this rig (the real SPEC-0002 middleware replaces the stub resolver).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { repoCounters, repositories, users } from "../../db/schema";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "./engine";
import { createApiRouter } from "../router";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["pull_requests", "issues", "action", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity is STUB_USER (id 1); pin an explicit id-1 row.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  // The DO cells persist across tests (only D1 is wiped) — drop the PR head
  // refs the create flow lands on the BASE cells so the next per-repo index
  // cannot CAS-conflict (the pulls.test.ts convention).
  for (const cellName of ["cf-gitea-stub/hpr-base", "cf-gitea-stub/hpr-priv"]) {
    const cell = env.REPO.getByName(cellName);
    const { refs } = await cell.listRefs();
    for (const ref of refs) {
      if (!ref.name.startsWith("refs/pull/")) {
        continue;
      }
      const deleted = await cell.deleteApiRef({ ref: ref.name, expectedOid: ref.target });
      if (deleted.tag === "invalid") {
        throw new Error(`seed ref cleanup failed: ${ref.name} (${deleted.reason})`);
      }
    }
  }
});

const db = () => drizzle(env.DB);

const TOKEN = "stub-token"; // any token resolves STUB_USER (id 1)
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const anonHeaders = { "Content-Type": "application/json" };

let repoSeq = 9700;

async function seedRepo(
  ownerId: number,
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await db().insert(repoCounters).values({ repoId: id, issueIndex: 0 });
  return id;
}

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Land `refs/heads/main` once per cell with a slug-independent commit — the
 *  SAME oid lands in the base and the fork cell (content addressing), which
 *  IS the fork relationship's shared history (forks are full copies,
 *  SPEC-0001b §5.2; the a16f60e fixture shape). */
async function seedSharedMain(pair: { ownerNamespace: string; slug: string }, readme: string): Promise<string> {
  const cell = env.REPO.getByName(`${pair.ownerNamespace}/${pair.slug}`);
  const existing = refTipMap(await engineReads(env, pair).listRefs()).get(branchRef("main"));
  if (existing !== undefined) return existing.target;
  const blob = new TextEncoder().encode(readme);
  const blobOid = await gitObjectOid("blob", blob);
  const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
  const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000002, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "shared base\n" });
  const put = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blob },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`shared main putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef("main"), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`shared main landing failed: ${landed.tag}`);
  const head = await cell.setHead("main");
  if (head.tag !== "ok") throw new Error("shared main setHead failed");
  return commit.oid;
}

/** One divergent child commit on the fork's `feature` branch (lands once). */
async function seedCommitOnBranch(pair: { ownerNamespace: string; slug: string }, parentTip: string): Promise<string> {
  const cell = env.REPO.getByName(`${pair.ownerNamespace}/${pair.slug}`);
  const existing = refTipMap(await engineReads(env, pair).listRefs()).get(branchRef("feature"));
  if (existing !== undefined) return existing.target;
  const readme = new TextEncoder().encode(`# ${pair.slug}\n`);
  const readmeOid = await gitObjectOid("blob", readme);
  const extra = new TextEncoder().encode("from the fork\n");
  const extraOid = await gitObjectOid("blob", extra);
  const tree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: "feature.txt", oid: extraOid },
  ]);
  const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000003, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [parentTip], author: person, committer: person, message: "feature\n" });
  const put = await cell.putApiObjects([
    { oid: readmeOid, type: "blob", data: readme },
    { oid: extraOid, type: "blob", data: extra },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`feature commit putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef("feature"), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`feature landing failed: ${landed.tag}`);
  return commit.oid;
}

interface ForkFixture {
  baseId: string;
  forkId: string;
  featureTip: string;
}

/** The stub's public base + a fork with one divergent `feature` branch.
 *  `owner = "alice"` → a readable-by-everyone PUBLIC fork; `owner = "stub"` →
 *  the stub's own PRIVATE fork (the owner arm of the gate — the only
 *  authenticated doer the stub resolver can produce). */
async function seedForkWithFeature(baseSlug: string, fork: { owner: "alice" | "stub" }): Promise<ForkFixture> {
  const baseId = await seedRepo(1, "cf-gitea-stub", baseSlug);
  let forkOwnerNamespace = "cf-gitea-stub";
  let forkOwnerId = 1;
  let forkSlug = baseSlug;
  let visibility: "public" | "private" = "public";
  if (fork.owner === "alice") {
    const rows = await db()
      .insert(users)
      .values({ username: "alice", usernameLower: "alice", isAdmin: false, status: "active", createdAt: new Date("2026-01-01T00:00:00Z") })
      .returning()
      .all();
    const alice = rows[0];
    if (alice === undefined) throw new Error("alice seed failed");
    forkOwnerNamespace = "alice";
    forkOwnerId = alice.id;
  } else {
    forkSlug = `${baseSlug}-fork`;
    visibility = "private";
  }
  const forkId = await seedRepo(forkOwnerId, forkOwnerNamespace, forkSlug, visibility);
  await db().update(repositories).set({ forkParent: baseId }).where(eq(repositories.id, forkId));
  const readme = `# ${baseSlug}\n`;
  const sharedTip = await seedSharedMain({ ownerNamespace: "cf-gitea-stub", slug: baseSlug }, readme);
  await seedSharedMain({ ownerNamespace: forkOwnerNamespace, slug: forkSlug }, readme);
  const featureTip = await seedCommitOnBranch({ ownerNamespace: forkOwnerNamespace, slug: forkSlug }, sharedTip);
  return { baseId, forkId, featureTip };
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`https://example.com${path}`, init), env);
};

async function createForkPull(baseSlug: string, head: string): Promise<Response> {
  return router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: "fork PR", head, base: "main" }),
  });
}

interface HeadBlock {
  label: string;
  ref: string;
  sha: string;
  repo_id: number;
  repo?: Record<string, unknown>;
}

describe("PR converter head.repo — the cross-repo read-gate render (convert/pull.go:187-199)", () => {
  it("renders the readable public fork's repo block (owner login, slug, numeric id, pull-only permissions) for the authenticated doer", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-base", { owner: "alice" });
    const created = await createForkPull("hpr-base", "alice:feature");
    expect(created.status).toBe(201);

    const got = await router()("/repos/cf-gitea-stub/hpr-base/pulls/1", { headers: authHeaders });
    expect(got.status).toBe(200);
    const body = await got.json<{ head: HeadBlock; base: HeadBlock }>();
    // The branch fields stay the PR-ref shape; the fork's identity renders.
    expect(body.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(body.head.repo).toMatchObject({
      name: "hpr-base",
      full_name: "alice/hpr-base",
      private: false,
      owner: { login: "alice" },
      // the doer (stub) is a stranger on alice's fork: read-only block,
      // upstream AccessModeRead → ToRepo permissions
      permissions: { admin: false, push: false, pull: true },
    });
    // the base side still renders the base repo
    expect(body.base.repo).toMatchObject({ full_name: "cf-gitea-stub/hpr-base" });
  });

  it("renders the same head repo in the LIST converter (ToAPIPullRequests shares the gate, pull.go:435-450)", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-base", { owner: "alice" });
    const created = await createForkPull("hpr-base", "alice:feature");
    expect(created.status).toBe(201);

    const listed = await router()("/repos/cf-gitea-stub/hpr-base/pulls", { headers: authHeaders });
    expect(listed.status).toBe(200);
    const items = await listed.json<Array<{ head: HeadBlock }>>();
    expect(items).toHaveLength(1);
    expect(items[0]?.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(items[0]?.head.repo).toMatchObject({ full_name: "alice/hpr-base", owner: { login: "alice" } });
  });

  it("renders the public fork's repo for an ANONYMOUS doer too — upstream grants anonymous Read on a public repo (repo_permission.go:468-472)", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-base", { owner: "alice" });
    const created = await createForkPull("hpr-base", "alice:feature");
    expect(created.status).toBe(201);

    const got = await router()("/repos/cf-gitea-stub/hpr-base/pulls/1", { headers: anonHeaders });
    expect(got.status).toBe(200);
    const body = await got.json<{ head: HeadBlock }>();
    expect(body.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(body.head.repo).toMatchObject({
      full_name: "alice/hpr-base",
      permissions: { admin: false, push: false, pull: true },
    });
  });

  it("renders a PRIVATE fork's repo for its OWNER (the stub-owned fork; admin/push/pull block) and hides it from anonymous doers", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-priv", { owner: "stub" });
    // the owner/name fork form — the fork's slug differs from the base's
    const created = await createForkPull("hpr-priv", "cf-gitea-stub/hpr-priv-fork:feature");
    expect(created.status).toBe(201);

    const owned = await router()("/repos/cf-gitea-stub/hpr-priv/pulls/1", { headers: authHeaders });
    expect(owned.status).toBe(200);
    const ownedBody = await owned.json<{ head: HeadBlock }>();
    expect(ownedBody.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(ownedBody.head.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-priv-fork",
      private: true,
      // the doer OWNS the head repo: upstream AccessModeOwner → ToRepo
      permissions: { admin: true, push: true, pull: true },
    });

    // anonymous on a private head repo: None (:442-446) → the -1/nil shape
    // with the branch fields intact (pull.go:118-121)
    const anon = await router()("/repos/cf-gitea-stub/hpr-priv/pulls/1", { headers: anonHeaders });
    expect(anon.status).toBe(200);
    const anonBody = await anon.json<{ head: HeadBlock }>();
    expect(anonBody.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: -1 });
    expect(anonBody.head.repo).toBeUndefined();

    // the list converter hides the same way
    const listed = await router()("/repos/cf-gitea-stub/hpr-priv/pulls", { headers: anonHeaders });
    expect(listed.status).toBe(200);
    const items = await listed.json<Array<{ head: HeadBlock }>>();
    expect(items[0]?.head).toMatchObject({ label: "feature", repo_id: -1 });
    expect(items[0]?.head.repo).toBeUndefined();
  });
});
