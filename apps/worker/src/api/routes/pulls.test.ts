/**
 * The pulls blocked-user arms on real D1 — the focused standalone mount for
 * the blocks-enforcement sweep (the full PR-block family lives in
 * src/api/pulls.test.ts over the full router, same mounting convention here).
 * Pins:
 *   - repoCreatePullRequest's arm (services/pull/pull.go:64-65 via
 *     NewPullRequest → pull.go:547): the POSTER blocked by the repo owner
 *     answers 403 "user is blocked" before any row or head ref is written;
 *   - repoEditPullRequest's arm (pull.go:687 → UpdateAssignees →
 *     validateAssignee, services/issue/assignee.go:168-170): the PATCH
 *     assignee replace validates EVERY unique name before any write, the
 *     blocked probe sits AFTER the already-assigned skip in the add loop's
 *     upstream shape (AddAssigneeIfNotAssigned) and BEFORE CanBeAssigned —
 *     the same skip rule the landed issue-tables-t2 arm pins.
 *
 * The full-router stub identity is STUB_USER (id 1); the seeded companions
 * (recluse, alice, bob) take the autoincrement ids 2+.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { comments, issueAssignees, issues, pullRequests, userBlocking, users, repositories } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "../services/engine";
import { createApiRouter } from "../router";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "pull_requests",
    "comments",
    "issue_assignees",
    "issues",
    "repo_counters",
    "user_blocking",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity is STUB_USER (id 1); pin an explicit id-1 row.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  // The DO cells persist across tests (only D1 is wiped above) — drop the
  // PR head refs the create flow lands on `recluse/blocked` so the next
  // per-repo index cannot CAS-conflict (the pulls.test.ts convention).
  const cell = env.REPO.getByName("recluse/blocked");
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
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const TOKEN = "stub-token"; // STUB_USER (id 1) — the acting doer
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 950;

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

const block = (blockerId: number, blockeeId: number) =>
  db().insert(userBlocking).values({ blockerId, blockeeId, note: "", createdAt: new Date() });

async function seedRepo(ownerId: number, ownerNamespace: string, slug: string): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
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

/** Real engine branches for the POST create flow (base/head existence is an
 *  engine read) — one deterministic root commit on `main`, the named branches
 *  pointing at it (the pulls.test.ts seed, idempotent over the persistent DO
 *  cell). */
async function seedEngineBranches(ownerLower: string, slug: string, branches: string[]): Promise<string> {
  const pair = { ownerNamespace: ownerLower, slug };
  const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
  const tips = refTipMap(await engineReads(env, pair).listRefs());
  const land = async (ref: string, oid: string): Promise<void> => {
    const result = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
    if (result.tag !== "committed") {
      throw new Error(`seed ref landing failed: ${ref} (${result.tag})`);
    }
  };
  let tip = tips.get(branchRef("main"))?.target;
  if (tip === undefined) {
    const blob = new TextEncoder().encode(`# ${slug}\n`);
    const blobOid = await gitObjectOid("blob", blob);
    const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
    const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000000, tz: "+0000" };
    const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "seed\n" });
    const put = await cell.putApiObjects([
      { oid: blobOid, type: "blob", data: blob },
      { oid: tree.oid, type: "tree", data: tree.data },
      { oid: commit.oid, type: "commit", data: commit.data },
    ]);
    if (put.tag !== "ok") {
      throw new Error(`seed putApiObjects failed: ${put.tag}`);
    }
    tip = commit.oid;
    await land(branchRef("main"), commit.oid);
    const head = await cell.setHead("main");
    if (head.tag !== "ok") {
      throw new Error("seed setHead failed");
    }
  }
  for (const branch of branches) {
    if (tips.get(branchRef(branch)) === undefined) {
      await land(branchRef(branch), tip);
    }
  }
  return tip;
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`https://example.com${path}`, init), env);
};

/** One PR row through the landed service (no engine refs — the head-ref
 *  landing is the route handler's job), for the PATCH-side fixtures. */
async function seedPullRequest(repoId: string, posterId: number): Promise<{ issueId: number; index: number }> {
  const { issue } = await service().createPullRequest({
    repoId,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "feature",
    title: "assign me",
    content: null,
    posterId,
    milestoneId: null,
    labelIds: [],
    allowMaintainerEdit: true,
    headSha: "0".repeat(40),
  });
  return { issueId: Number(issue.id), index: issue.index };
}

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/pulls: the NewPullRequest blocked arm
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/pulls: the NewPullRequest blocked arm", () => {
  it("403s \"user is blocked\" when the poster is blocked by the repo owner (pull.go:64-65 via pull.go:547)", async () => {
    const recluse = await seedUser("recluse");
    await seedRepo(recluse.id, "recluse", "blocked");
    await seedEngineBranches("recluse", "blocked", ["feature"]);
    await block(recluse.id, 1);
    const res = await router()("/repos/recluse/blocked/pulls", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "blocked PR", head: "feature", base: "main" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await db().select().from(issues).all()).toHaveLength(0);
    expect(await db().select().from(pullRequests).all()).toHaveLength(0);
  });

  it("201s once no blocking row relates the pair (the arm lifts with the block)", async () => {
    const recluse = await seedUser("recluse");
    await seedRepo(recluse.id, "recluse", "blocked");
    await seedEngineBranches("recluse", "blocked", ["feature"]);
    await block(recluse.id, 1);
    await env.DB.prepare("DELETE FROM user_blocking").run();
    const res = await router()("/repos/recluse/blocked/pulls", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "open again", head: "feature", base: "main" }),
    });
    expect(res.status).toBe(201);
    expect(await db().select().from(pullRequests).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PATCH /repos/{owner}/{repo}/pulls/{index}: the UpdateAssignees surface with
// the validateAssignee blocked arm (pull.go:687 → assignee.go:168-170)
// ---------------------------------------------------------------------------

describe("PATCH …/pulls/{index} assignees: the UpdateAssignees blocked arm", () => {
  /** The stub-owned repo (the doer is the owner → the writer gate passes)
   *  with one PR. */
  async function seedOwnedList(): Promise<{ repoId: string; index: number }> {
    const repoId = await seedRepo(1, "cf-gitea-stub", "assignable");
    const pr = await seedPullRequest(repoId, 1);
    return { repoId, index: pr.index };
  }

  it("403s \"user is blocked\" when the doer is blocked by a requested assignee — before ANY write (the pre-tx validateAssignee loop, assignee.go:169-170)", async () => {
    const { index } = await seedOwnedList();
    const alice = await seedUser("alice");
    await block(alice.id, 1);
    const res = await router()(`/repos/cf-gitea-stub/assignable/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    expect(await db().select().from(issueAssignees).all()).toHaveLength(0);
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("403s a blocked name even when ALREADY assigned — UpdateAssignees validates every requested name pre-write (assignee.go:185-198), unlike the POST /assignees arm's skip-first order", async () => {
    const { repoId, index } = await seedOwnedList();
    const alice = await seedUser("alice");
    const pr = await service().getIssueByIndex(repoId, index);
    expect(pr).not.toBeNull();
    await db().insert(issueAssignees).values({ issueId: pr!.id, assigneeId: alice.id });
    await block(alice.id, 1);
    const res = await router()(`/repos/cf-gitea-stub/assignable/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    // No write of any kind — the probe is the pre-tx validation loop.
    expect(await db().select().from(issueAssignees).all()).toHaveLength(1);
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("the already-assigned skip: a requested, unblocked name already on the set produces no remove/add/comment (AddAssigneeIfNotAssigned, the landed skip rule)", async () => {
    const { repoId, index } = await seedOwnedList();
    const alice = await seedUser("alice");
    const pr = await service().getIssueByIndex(repoId, index);
    expect(pr).not.toBeNull();
    await db().insert(issueAssignees).values({ issueId: pr!.id, assigneeId: alice.id });
    const res = await router()(`/repos/cf-gitea-stub/assignable/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    expect(res.status).toBe(201);
    expect(await db().select().from(issueAssignees).all()).toHaveLength(1);
    expect(await db().select().from(comments).all()).toHaveLength(0);
  });

  it("replaces the set: unrequested assignees are removed (with the type-9 comment), requested ones added", async () => {
    const { repoId, index } = await seedOwnedList();
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const issue = await service().getIssueByIndex(repoId, index);
    expect(issue).not.toBeNull();
    await db().insert(issueAssignees).values({ issueId: issue!.id, assigneeId: bob.id });
    const res = await router()(`/repos/cf-gitea-stub/assignable/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    expect(res.status).toBe(201);
    const rows = await db().select().from(issueAssignees).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.assigneeId).toBe(alice.id);
    // One toggle comment per changed assignee (type 9, the removal carries
    // the removed flag).
    const toggles = await db().select().from(comments).all();
    expect(toggles).toHaveLength(2);
  });

  it("an empty array clears the set (the upstream [] clear arm)", async () => {
    const { repoId, index } = await seedOwnedList();
    const bob = await seedUser("bob");
    const issue = await service().getIssueByIndex(repoId, index);
    expect(issue).not.toBeNull();
    await db().insert(issueAssignees).values({ issueId: issue!.id, assigneeId: bob.id });
    const res = await router()(`/repos/cf-gitea-stub/assignable/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: [] }),
    });
    expect(res.status).toBe(201);
    expect(await db().select().from(issueAssignees).all()).toHaveLength(0);
  });

  it("422s an unknown assignee name with pull.go:688's wrapper message", async () => {
    const { index } = await seedOwnedList();
    const res = await router()(`/repos/cf-gitea-stub/assignable/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["ghost"] }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: "Assignee does not exist: [name: user does not exist [uid: 0, name: ghost]]",
      url: ERROR_URL,
    });
  });

  it("the arm sits inside the writer gate — a non-writer PATCH ignores the assignee fields (upstream's CanWrite arm)", async () => {
    const recluse = await seedUser("recluse");
    const repoId = await seedRepo(recluse.id, "recluse", "stranger");
    const pr = await seedPullRequest(repoId, recluse.id);
    const res = await router()(`/repos/recluse/stranger/pulls/${pr.index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    // The stub is neither poster nor writer on recluse's repo — the bare 403
    // (the landed canEditPullRequest arm) precedes the assignee surface.
    expect(res.status).toBe(403);
    expect(await db().select().from(issueAssignees).all()).toHaveLength(0);
  });
});
