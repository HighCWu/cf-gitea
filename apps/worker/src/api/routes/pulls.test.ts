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
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { comments, issueAssignees, issues, pullRequests, userBlocking, users, repositories } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { carryRepoCell } from "../../repos/carry";
import { RepoService } from "../../repos/service";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "../services/engine";
import { createApiRouter } from "../router";

// wave-129 full-run contention budget: this file's heaviest closure measured
// 6.01s of the 30s default IN a green 8-worker full run (the bare head-grammar
// create walk; the suite's 260-isolate spawn storm spikes closures up to ~12x
// their solo time). File-local 90s budgets; vitest.config.ts keeps 30s for
// every other file. Membership: the measured >=4s in-run closure/hook set
// (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

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
    "action",
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
  // The renamed-fork suite below adds its base cells (append-only).
  const cleanupCells = ["recluse/blocked", "cf-gitea-stub/emptypr", "cf-gitea-stub/renfork", "cf-gitea-stub/renfork2", "cf-gitea-stub/chainchild"];
  for (const cellName of cleanupCells) {
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
// POST /repos/{owner}/{repo}/pulls: the equal-tips arms (the API gate is the
// upstream-verbatim STRING equality, routers/api/v1/repo/pull.go:395-399 —
// raw form fields, checked before parseCompareInfo; the create side is
// tips-blind, so the create accepts an empty diff exactly when the rendered
// AllowEmptyPr gate would show the form: acrossRepoPr = !IsSameRef,
// services/git/compare.go:41-43)
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/pulls: the equal-tips arms (the string gate, upstream pull.go:395-399)", () => {
  it("422s the SAME-ref pair with the verbatim message — the gate is string equality (IsSameRef's API arm), tips never consulted", async () => {
    await seedRepo(1, "cf-gitea-stub", "emptypr");
    await seedEngineBranches("cf-gitea-stub", "emptypr", []);
    const res = await router()("/repos/cf-gitea-stub/emptypr/pulls", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "same ref", head: "main", base: "main" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: "Invalid PullRequest: There are no changes between the head and the base",
      url: ERROR_URL,
    });
    expect(await db().select().from(pullRequests).all()).toHaveLength(0);
  });

  it("201s the ACROSS-REF equal-tips pair — two branch names at one commit create the empty PR (pull.go:395 strings differ; the tips-blind create accepts the empty diff under AllowEmptyPr's reduction)", async () => {
    const repoId = await seedRepo(1, "cf-gitea-stub", "emptypr");
    // seedEngineBranches lands EVERY named branch at main's tip: main and
    // main-mirror share one commit — the equal-tips, differing-names shape.
    const tip = await seedEngineBranches("cf-gitea-stub", "emptypr", ["main-mirror"]);
    const res = await router()("/repos/cf-gitea-stub/emptypr/pulls", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "the empty pr", head: "main-mirror", base: "main" }),
    });
    expect(res.status).toBe(201);
    const rendered = await res.json<Record<string, unknown>>();
    expect(rendered.title).toBe("the empty pr");
    expect(rendered.head).toMatchObject({ label: "main-mirror", ref: "refs/pull/1/head", sha: tip });
    // The row: zero-diff semantics — headSha IS the base tip, mergeBase
    // stays null (same-repo creates carry none; the lazy check computes it).
    const rows = await db().select().from(pullRequests).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      headRepoId: repoId,
      baseRepoId: repoId,
      headBranch: "main-mirror",
      baseBranch: "main",
      headSha: tip,
      mergeBase: null,
    });
    // The refs/pull/1/head CAS write landed at the shared tip.
    const refNames = (await env.REPO.getByName("cf-gitea-stub/emptypr").listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/pull/1/head");
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

// ---------------------------------------------------------------------------
// Activity feeds — the PR-lifecycle `action` rows (specs/activity-feeds.md
// §3.3 tail): create/close/reopen/merge_pull_request ride the LOCAL
// emitPullWebhook seam with the landed emitters' recordAction pattern; the
// rows are read back through GET /repos/{owner}/{repo}/activities/feeds
// (registered in router.ts). Upstream: services/feed/notifier.go.
// ---------------------------------------------------------------------------

/** `feature` = main + one commit (the pull-merge-protection.test.ts
 *  ancestry shape) so the PR checks Mergeable and the merge RPC runs. */
async function seedFeatureAhead(ownerLower: string, slug: string, baseTip: string): Promise<string> {
  const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
  const readme = new TextEncoder().encode(`# ${slug}\n`);
  const readmeOid = await gitObjectOid("blob", readme);
  const extra = new TextEncoder().encode("feature work\n");
  const extraOid = await gitObjectOid("blob", extra);
  const tree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: "feature.txt", oid: extraOid },
  ]);
  const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000001, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [baseTip], author: person, committer: person, message: "feature\n" });
  const put = await cell.putApiObjects([
    { oid: extraOid, type: "blob", data: extra },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`seed feature putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef("feature"), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`seed feature landing failed: ${landed.tag}`);
  return commit.oid;
}

describe("activity feeds — PR-lifecycle action rows", () => {
  const feeds = (owner: string, slug: string): Promise<Response> => router()(`/repos/${owner}/${slug}/activities/feeds`);

  it("POST create records create_pull_request with index|title (feed/notifier.go NewPullRequest :129-153)", async () => {
    await seedRepo(1, "cf-gitea-stub", "feed-create");
    await seedEngineBranches("cf-gitea-stub", "feed-create", ["feature"]);
    const res = await router()("/repos/cf-gitea-stub/feed-create/pulls", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "feed me", head: "feature", base: "main" }),
    });
    expect(res.status).toBe(201);
    const feed = await feeds("cf-gitea-stub", "feed-create");
    expect(feed.status).toBe(200);
    const body = await feed.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      op_type: "create_pull_request",
      content: "1|feed me",
      act_user_id: 1,
      is_private: false,
      ref_name: "",
    });
  });

  it("PATCH close/reopen records close/reopen_pull_request with index| (IssueChangeStatus :69-95)", async () => {
    const repoId = await seedRepo(1, "cf-gitea-stub", "feed-state");
    const { index } = await seedPullRequest(repoId, 1);
    const patch = (state: string): Promise<Response> =>
      router()(`/repos/cf-gitea-stub/feed-state/pulls/${index}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ state }),
      });
    expect((await patch("closed")).status).toBe(201);
    expect((await patch("open")).status).toBe(201);
    const body = await (await feeds("cf-gitea-stub", "feed-state")).json<Array<Record<string, unknown>>>();
    // created DESC: the reopen is newest. Content is the bare `index|`
    // (upstream composes "%d|" with an empty half, :77).
    expect(body.map((row) => [row.op_type, row.content])).toEqual([
      ["reopen_pull_request", `${index}|`],
      ["close_pull_request", `${index}|`],
    ]);
  });

  it("POST merge records merge_pull_request with index|title — and NOT a second close row (MergePullRequest :263-275)", async () => {
    const slug = "feed-merge";
    await seedRepo(1, "cf-gitea-stub", slug);
    await seedEngineBranches("cf-gitea-stub", slug, []);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: "cf-gitea-stub", slug }).listRefs());
    const mainTip = tips.get(branchRef("main"))?.target;
    expect(mainTip).toBeDefined();
    await seedFeatureAhead("cf-gitea-stub", slug, mainTip as string);
    const create = await router()(`/repos/cf-gitea-stub/${slug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "merge me", head: "feature", base: "main" }),
    });
    expect(create.status).toBe(201);
    const merge = await router()(`/repos/cf-gitea-stub/${slug}/pulls/1/merge`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ do: "merge" }),
    });
    expect(merge.status).toBe(200);
    const body = await (await feeds("cf-gitea-stub", slug)).json<Array<Record<string, unknown>>>();
    // created DESC: the merge row, then the POST's own create row. The merge
    // path writes the MERGE action only — upstream fires
    // NotifyMergePullRequest alone (the merge never goes through
    // IssueChangeStatus), so a close row here would be a divergence.
    expect(body.map((row) => [row.op_type, row.content])).toEqual([
      ["merge_pull_request", "1|merge me"],
      ["create_pull_request", "1|merge me"],
    ]);
  });

  it("PATCH assignees records NO action row — upstream has none to write (no assign ActionType; feed/notifier.go has no assignee method, SPEC §3.3)", async () => {
    const repoId = await seedRepo(1, "cf-gitea-stub", "feed-assign");
    await seedUser("alice");
    const { index } = await seedPullRequest(repoId, 1);
    const res = await router()(`/repos/cf-gitea-stub/feed-assign/pulls/${index}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    expect(res.status).toBe(201); // the assignee change itself went through
    expect((await env.DB.prepare("SELECT * FROM action").all()).results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/pulls — the cross-repo (fork head) create arm.
// The `user:branch` grammar resolves the head REPO (resolveHeadRepo), the
// doer's READ gate covers it (parseCompareInfo pull.go:1063-1074), the branch
// read runs in the fork's cell (upstream opens headGitRepo, pull.go:1078-1089),
// the merge base computes THERE (GetCompareInfo services/git/compare.go:73-89
// — upstream fetches the base commit into the head repo and merge-bases in it;
// our forks are full copies, SPEC-0001b §5.2, so the shared history is already
// in the fork's cell) and the head's divergent closure carries into the base
// cell so refs/pull/N/head + mergeability/diff/merge resolve there. This is
// the 2e3db28 seeded-helper staging shape, made API-reachable.
// ---------------------------------------------------------------------------

/** Cells hold content across tests (only D1 is wiped) — land
 *  `refs/heads/main` once per cell with a deterministic commit that does NOT
 *  depend on the slug, so the SAME oid lands in the base and the fork cell:
 *  that shared commit IS the fork relationship's common history (content
 *  addressing — forks are full copies, so both cells hold it). */
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

/** One child commit on `branch` — the fork's divergent head, or the base's
 *  next commit for the base-advanced fixture. Lands only when absent. */
async function seedCommitOnBranch(
  pair: { ownerNamespace: string; slug: string },
  branch: string,
  parentTip: string,
  file: string,
  content: string,
  time: number,
): Promise<string> {
  const cell = env.REPO.getByName(`${pair.ownerNamespace}/${pair.slug}`);
  const existing = refTipMap(await engineReads(env, pair).listRefs()).get(branchRef(branch));
  if (existing !== undefined) return existing.target;
  const readme = new TextEncoder().encode(`# ${pair.slug}\n`);
  const readmeOid = await gitObjectOid("blob", readme);
  const extra = new TextEncoder().encode(content);
  const extraOid = await gitObjectOid("blob", extra);
  const tree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: file, oid: extraOid },
  ]);
  const person = { name: "seed", email: "seed@pulls.invalid", time, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [parentTip], author: person, committer: person, message: `${branch}\n` });
  const put = await cell.putApiObjects([
    { oid: readmeOid, type: "blob", data: readme },
    { oid: extraOid, type: "blob", data: extra },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`branch commit putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef(branch), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`branch landing failed: ${landed.tag}`);
  return commit.oid;
}

/** The stub's public base + alice's fork (default slug, `fork_parent` set)
 *  with one divergent `feature` branch; both cells share the seeded main. */
async function seedForkWithFeature(
  baseSlug: string,
  options: { privateFork?: boolean } = {},
): Promise<{ baseId: string; forkId: string; sharedTip: string; featureTip: string }> {
  const baseId = await seedRepo(1, "cf-gitea-stub", baseSlug);
  const alice = await seedUser("alice");
  const forkId = await seedRepo(alice.id, "alice", baseSlug, options.privateFork === true ? "private" : "public");
  await db().update(repositories).set({ forkParent: baseId }).where(eq(repositories.id, forkId));
  const readme = `# ${baseSlug}\n`;
  const sharedTip = await seedSharedMain({ ownerNamespace: "cf-gitea-stub", slug: baseSlug }, readme);
  await seedSharedMain({ ownerNamespace: "alice", slug: baseSlug }, readme);
  const featureTip = await seedCommitOnBranch({ ownerNamespace: "alice", slug: baseSlug }, "feature", sharedTip, "feature.txt", "from the fork\n", 1761000003);
  return { baseId, forkId, sharedTip, featureTip };
}

describe("POST /repos/{owner}/{repo}/pulls: the cross-repo (fork head) create arm", () => {
  it("201s a fork-head PR — head 'alice:feature' resolves the fork's cell, the merge base computes there, the head closure carries into the base, and the PR lists, compares and merges", async () => {
    const baseSlug = "forkcreate";
    const { baseId, forkId, sharedTip, featureTip } = await seedForkWithFeature(baseSlug);
    const create = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "fork PR", head: "alice:feature", base: "main" }),
    });
    expect(create.status).toBe(201);
    const rendered = await create.json<Record<string, unknown>>();
    expect(rendered.title).toBe("fork PR");
    // head.sha is the fork tip cache; the fork is PUBLIC and the doer reads
    // it, so the converter renders the head repo per upstream's gate
    // (services/pulls.ts headBranchInfo — convert/pull.go:197-199
    // HasAnyUnitAccessOrPublicAccess; the old hidden -1 shape was the
    // pre-fork-render divergence, flipped by the wave-34 render port)
    expect(rendered.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(rendered.head).toHaveProperty("repo");

    const rows = await db().select().from(pullRequests).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      headRepoId: forkId,
      baseRepoId: baseId,
      headBranch: "feature",
      baseBranch: "main",
      headSha: featureTip,
      mergeBase: sharedTip,
    });

    // GET: the lazy mergeability check runs in the base cell against the
    // carried closure and lands Mergeable.
    const got = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls/1`);
    expect(got.status).toBe(200);
    expect(await got.json<Record<string, unknown>>()).toMatchObject({ mergeable: true, merge_base: sharedTip });

    // compare: the range diff lists the fork's feature file.
    const files = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls/1/files`);
    expect(files.status).toBe(200);
    expect((await files.json<Array<Record<string, unknown>>>()).map((f) => f.filename)).toEqual(["feature.txt"]);

    // merge: the three-way runs in the base cell and advances main.
    const merge = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls/1/merge`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ do: "merge" }),
    });
    expect(merge.status).toBe(200);
    const mainTip = refTipMap(await engineReads(env, { ownerNamespace: "cf-gitea-stub", slug: baseSlug }).listRefs()).get(branchRef("main"))?.target;
    expect(mainTip).toBeDefined();
    expect(mainTip).not.toBe(sharedTip);
  });

  it("404s a head branch the fork's cell does not have — the branch existence read runs in the HEAD cell", async () => {
    const baseSlug = "forkmiss";
    await seedForkWithFeature(baseSlug);
    const res = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "missing head", head: "alice:nope", base: "main" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Head branch does not exist [name: nope]", url: ERROR_URL });
    expect(await db().select().from(pullRequests).all()).toHaveLength(0);
  });

  it("404s an UNREADABLE head repo — parseCompareInfo's CanRead gate answers not-found (pull.go:1070-1074), the same anti-enumeration 404 as an absent head repo", async () => {
    const baseSlug = "forkgate";
    await seedForkWithFeature(baseSlug, { privateFork: true });
    const unreadable = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "private head", head: "alice:feature", base: "main" }),
    });
    expect(unreadable.status).toBe(404);
    expect(await unreadable.json()).toEqual({ message: "not found", url: ERROR_URL });
    const absent = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "ghost head", head: "ghost:feature", base: "main" }),
    });
    expect(absent.status).toBe(404);
    expect(await db().select().from(pullRequests).all()).toHaveLength(0);
  });

  it("fetches the base tip into the fork cell when the base advanced past the fork point (the FetchRemoteTempCommit port, compare.go:73-80) — the merge base still computes", async () => {
    const baseSlug = "forkahead";
    const { sharedTip, featureTip } = await seedForkWithFeature(baseSlug);
    await seedCommitOnBranch({ ownerNamespace: "cf-gitea-stub", slug: baseSlug }, "main", sharedTip, "base-only.txt", "ahead of the fork\n", 1761000004);
    const create = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "stale fork", head: "alice:feature", base: "main" }),
    });
    expect(create.status).toBe(201);
    const rows = await db().select().from(pullRequests).all();
    expect(rows).toHaveLength(1);
    // The merge base is the SHARED fork point — not null: the base fetch made
    // the head-cell computation possible.
    expect(rows[0]).toMatchObject({ headSha: featureTip, mergeBase: sharedTip });
  });
});

// ---------------------------------------------------------------------------
// The bare `owner:branch` head grammar through a fork RENAME — the fork EDGE
// (upstream FindHeadRepo, routers/common/compare.go:134-150 → GetUserFork,
// models/repo/fork.go:45-55: `fork_id = ? AND owner_id = ?`) is name-free, so
// a renamed fork keeps resolving. The pre-fix resolver looked the head up by
// path (owner, base slug) and 404'd once the fork's slug moved. Upstream's
// LookupRedirect (models/repo/redirect.go:55-64) plays no part in this
// resolution — the bare grammar carries no repo name to redirect.
// ---------------------------------------------------------------------------

/** The real rename path (D1 rows + the RepoDO cell carry) — a raw slug
 *  UPDATE would strand the branches under the old cell name. */
const renamingRepoService = () =>
  new RepoService(env.DB, { carry: (from, to, storageKey) => carryRepoCell(env, from, to, storageKey) });

describe("POST /repos/{owner}/{repo}/pulls: the bare head grammar follows the fork edge through a fork rename", () => {
  it("201s head 'alice:feature' after the fork is RENAMED (old slug gone) — the fork edge resolves the renamed fork and the PR carries its new identity", async () => {
    const baseSlug = "renfork";
    const { baseId, forkId, sharedTip, featureTip } = await seedForkWithFeature(baseSlug);
    await renamingRepoService().rename(forkId, "renfork-moved");
    // The (alice, base slug) path is now dead — nothing resolves there (the
    // redirect row is invisible to resolveHeadRepo, like upstream).
    const create = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "renamed fork PR", head: "alice:feature", base: "main" }),
    });
    expect(create.status).toBe(201);
    const rendered = await create.json<{ head: { label: string; sha: string; repo_id: number; repo?: { full_name: string } } }>();
    expect(rendered.head).toMatchObject({ label: "feature", sha: featureTip, repo_id: Number(forkId) });
    // the renamed identity renders (the converter reads the row, not the grammar)
    expect(rendered.head.repo).toMatchObject({ full_name: "alice/renfork-moved" });
    const rows = await db().select().from(pullRequests).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      headRepoId: forkId,
      baseRepoId: baseId,
      headBranch: "feature",
      baseBranch: "main",
      headSha: featureTip,
      mergeBase: sharedTip,
    });
  });

  it("prefers the fork edge over a same-named non-fork squatting the base's slug (fork-edge-before-path — the upstream-true winner, compare.go:173)", async () => {
    const baseSlug = "renfork2";
    const { forkId } = await seedForkWithFeature(baseSlug);
    await renamingRepoService().rename(forkId, "renfork2-moved");
    const forkRow = await db().select().from(repositories).where(eq(repositories.id, forkId)).get();
    if (forkRow === undefined || forkRow.ownerId === null) throw new Error("fork row seed failed");
    // The decoy: the same owner's NON-fork repo occupying the fork's old slug.
    const decoyId = await seedRepo(forkRow.ownerId, "alice", baseSlug);
    expect(Number(decoyId)).not.toBe(Number(forkId));
    const create = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "edge wins", head: "alice:feature", base: "main" }),
    });
    expect(create.status).toBe(201);
    const rendered = await create.json<{ head: { repo_id: number } }>();
    expect(rendered.head.repo_id).toBe(Number(forkId));
  });

  it("climbs the fork chain when the BASE is a fork — an ancestor owned by the head user IS the head repo (compare.go:135-147)", async () => {
    const childSlug = "chainchild";
    const baseId = await seedRepo(1, "cf-gitea-stub", childSlug);
    const alice = await seedUser("alice");
    const rootId = await seedRepo(alice.id, "alice", "chainroot");
    await db().update(repositories).set({ forkParent: rootId }).where(eq(repositories.id, baseId));
    const readme = "# chainroot\n";
    const sharedTip = await seedSharedMain({ ownerNamespace: "cf-gitea-stub", slug: childSlug }, readme);
    await seedSharedMain({ ownerNamespace: "alice", slug: "chainroot" }, readme);
    const featureTip = await seedCommitOnBranch({ ownerNamespace: "alice", slug: "chainroot" }, "feature", sharedTip, "feature.txt", "from the root\n", 1761000005);
    const create = await router()(`/repos/cf-gitea-stub/${childSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "chain PR", head: "alice:feature", base: "main" }),
    });
    expect(create.status).toBe(201);
    const rendered = await create.json<{ head: { repo_id: number; sha: string } }>();
    expect(rendered.head).toMatchObject({ repo_id: Number(rootId), sha: featureTip });
  });

  it("404s a KNOWN head owner with neither a fork of the base nor a same-slug repo — the flat anti-enumeration 404 (upstream's known-user arm is 400 'the user %s does not have a fork of the base repository', compare.go:178 — the deliberate status deviation)", async () => {
    const baseSlug = "renfork-nofork";
    await seedRepo(1, "cf-gitea-stub", baseSlug);
    await seedUser("bob");
    const res = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "x", head: "bob:feature", base: "main" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
    expect(await db().select().from(pullRequests).all()).toHaveLength(0);
  });
});
